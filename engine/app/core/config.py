from types import SimpleNamespace
def get_settings():
    from tempfile import gettempdir
    from local_hardware import budget
    limits = budget(gettempdir())
    return SimpleNamespace(duckdb_threads=limits['cpu_threads'],
                           duckdb_memory_limit=str(limits['duckdb_memory_bytes'])+'B',
                           duckdb_spill_limit=str(limits['spill_bytes'])+'B',
                           disk_reserve=limits['disk_reserve_bytes'],
                           memory_reserve=limits['memory_reserve_bytes'], hardware=limits)
