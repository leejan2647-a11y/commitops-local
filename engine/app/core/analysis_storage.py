"""Private, disposable working storage for one DuckDB analysis.

Source uploads remain in their retained storage. Only reproducible processing
files use the operating system's temporary volume.
"""
from tempfile import TemporaryDirectory, gettempdir
from pathlib import Path
from contextlib import contextmanager
import os
import shutil
import stat
import threading
from duckdb import ConnectionException, Error as DuckDBError



class AnalysisStorageError(OSError):
    """Processing storage failed, independently of provider export validity."""


def _lock(handle, *, blocking=True):
    if os.name == 'nt':
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


@contextmanager
def _root_lock(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or (hasattr(os,'getuid') and info.st_uid != os.getuid()):
        raise OSError('Private analysis working storage is unavailable')
    if os.name != 'nt' and stat.S_IMODE(info.st_mode) & 0o077:
        raise OSError('Private analysis working storage permissions are unsafe')
    # Root ownership/mode prevent substitution of this lock or job leases.
    with (root/'.lock').open('a+b') as handle:
        if handle.tell()==0:
            handle.write(b'0');handle.flush()
        _lock(handle)
        yield


def _reap_locked(root):
    for directory in root.glob('job-*'):
        if directory.is_symlink() or not directory.is_dir():
            continue
        lease=directory/'.lease'
        if not lease.exists():
            # Initialization also holds the root lock. An empty directory
            # without a lease can only be an interrupted pre-database setup.
            try:
                directory.rmdir()
            except OSError:
                pass  # Preserve any unrecognized, nonempty directory.
            continue
        if lease.is_symlink() or not lease.is_file():
            continue
        try:
            with lease.open('r+b') as handle:
                _lock(handle, blocking=False)
                # A worker holding this lease cannot be reaped, including
                # workers in a different PID namespace. The OS releases it on
                # timeout/SIGKILL without relying on a Python finally block.
                if os.name != 'nt':
                    shutil.rmtree(directory)
            if os.name == 'nt':
                shutil.rmtree(directory)
        except (OSError, PermissionError):
            continue


def reap_orphans(root):
    with _root_lock(root):
        _reap_locked(root)


class AnalysisConnection:
    def __init__(self, connection, working, lease, *, disk_reserve=0, memory_reserve=0):
        self._connection = connection
        self._working = working
        self._lease = lease
        self._stop = threading.Event()
        self._storage_failed = False
        self._closed = False
        self._disk_reserve = disk_reserve
        self._memory_reserve = memory_reserve
        self._cursors = set()
        self._cursor_lock = threading.Lock()
        self._monitor = threading.Thread(target=self._watch_storage, name='analysis-storage-guard', daemon=True)
        self._monitor.start()

    def _watch_storage(self):
        while not self._stop.wait(1):
            try:
                free = shutil.disk_usage(self._working.name).free
            except OSError:
                free = 0
            if self._stop.is_set():
                return
            from local_hardware import memory
            available, _ = memory()
            if free < self._disk_reserve or available < self._memory_reserve//2:
                self._storage_failed = True
                with self._cursor_lock:
                    connections = [self._connection, *self._cursors]
                for connection in connections:
                    try:
                        connection.interrupt()
                    except DuckDBError:
                        pass  # A cursor may have closed after the snapshot.
                return

    def _ensure_available(self):
        if self._closed:
            raise ConnectionException('Analysis connection is closed')
        if self._storage_failed:
            raise AnalysisStorageError('Your device has insufficient available memory or working disk to continue safely')

    def _new_cursor(self, source):
        with self._cursor_lock:
            self._ensure_available()
            connection = source.cursor()
            self._cursors.add(connection)
        return AnalysisCursor(self, connection)

    def cursor(self):
        return self._new_cursor(self._connection)

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def execute(self, *args, **kwargs):
        self._ensure_available()
        result = self._connection.execute(*args, **kwargs)
        return self if result is self._connection else result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        with self._cursor_lock:
            if self._closed:
                return
            self._closed = True
            working = self._working
            cursors = list(self._cursors)
            self._cursors.clear()
        self._stop.set()
        self._monitor.join(timeout=3)
        self._working = None
        try:
            for connection in [self._connection, *cursors]:
                try:
                    connection.interrupt()
                except DuckDBError:
                    pass
            try:
                for cursor in cursors:
                    try:
                        cursor.close()
                    except DuckDBError:
                        pass
            finally:
                self._connection.close()
        finally:
            try:
                self._lease.close()
            finally:
                working.cleanup()


class AnalysisCursor:
    def __init__(self, owner, connection):
        self._owner, self._connection = owner, connection

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def execute(self, *args, **kwargs):
        self._owner._ensure_available()
        result = self._connection.execute(*args, **kwargs)
        return self if result is self._connection else result

    def fetchmany(self, *args, **kwargs):
        self._owner._ensure_available()
        return self._connection.fetchmany(*args, **kwargs)

    def fetch_record_batch(self, *args, **kwargs):
        self._owner._ensure_available()
        return self._connection.fetch_record_batch(*args, **kwargs)

    def to_arrow_reader(self, *args, **kwargs):
        self._owner._ensure_available()
        return self._connection.to_arrow_reader(*args, **kwargs)

    def cursor(self):
        return self._owner._new_cursor(self._connection)

    def close(self):
        with self._owner._cursor_lock:
            self._owner._cursors.discard(self._connection)
        self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def connect(settings):
    import duckdb

    root=Path(gettempdir()) / ('commitops-local-analysis-' + str(os.getuid() if hasattr(os,'getuid') else 'local'))
    with _root_lock(root):
        _reap_locked(root)
        if shutil.disk_usage(root).free <= settings.disk_reserve:
            raise AnalysisStorageError('Insufficient private analysis working storage')
        working = TemporaryDirectory(prefix='job-', dir=root)
        lease=(Path(working.name)/'.lease').open('w+b')
        lease.write(b'0');lease.flush()
        _lock(lease)
    try:
        connection = duckdb.connect(":memory:", config={
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "threads": settings.duckdb_threads,
            "memory_limit": settings.duckdb_memory_limit,
            "max_temp_directory_size": settings.duckdb_spill_limit,
            "temp_directory": working.name,
        })
    except BaseException:
        lease.close()
        working.cleanup()
        raise
    wrapper = AnalysisConnection(connection, working, lease, disk_reserve=settings.disk_reserve, memory_reserve=settings.memory_reserve)
    wrapper.hardware = dict(settings.hardware)
    return wrapper
