"""Device-derived processing budgets, never commercial input-size limits."""
import os
import shutil
from pathlib import Path
import psutil


def _integer(path):
    try:
        value = Path(path).read_text().strip()
        return int(value) if value != 'max' else None
    except (OSError, ValueError):
        return None


def memory():
    stats = psutil.virtual_memory()
    available, total = stats.available, stats.total
    maximum, used = _integer('/sys/fs/cgroup/memory.max'), _integer('/sys/fs/cgroup/memory.current')
    if maximum is None:
        maximum, used = _integer('/sys/fs/cgroup/memory/memory.limit_in_bytes'), _integer('/sys/fs/cgroup/memory/memory.usage_in_bytes')
    if maximum and used is not None:
        total, available = min(total, maximum), min(available, max(0, maximum-used))
    return int(available), int(total)


def threads():
    count = os.cpu_count() or 1
    try:
        count = min(count, len(psutil.Process().cpu_affinity()))
    except (AttributeError, OSError, psutil.Error):
        pass
    try:
        quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().split()
        if quota != 'max':
            count = min(count, max(1, (int(quota)+int(period)-1)//int(period)))
    except (OSError, ValueError):
        quota, period = _integer('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), _integer('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
        if quota and quota > 0 and period:
            count = min(count, max(1, (quota+period-1)//period))
    return max(1, count)


def disk(path):
    usage = shutil.disk_usage(path)
    # Keep a fraction of currently free space for the OS and other applications.
    reserve = max(1, usage.free//10)
    return {'free_bytes': usage.free, 'reserve_bytes': reserve, 'usable_bytes': max(0, usage.free-reserve)}


def budget(path):
    available, total = memory()
    storage = disk(path)
    return {'cpu_threads': threads(), 'available_memory_bytes': available, 'total_memory_bytes': total,
            'duckdb_memory_bytes': max(1, available*7//10), 'memory_reserve_bytes': max(1, available//4),
            'spill_bytes': max(1, storage['usable_bytes']), 'disk_reserve_bytes': storage['reserve_bytes'],
            'input_size_cap_bytes': None, 'scope': 'available hardware at calculation time'}
