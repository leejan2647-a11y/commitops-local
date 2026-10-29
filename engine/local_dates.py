"""Observed file bounds for manual period selection, never completeness proof."""
from datetime import date, timedelta
from app.core.resources import analysis_connection


def inspect(path):
    reader = 'read_parquet(?)' if str(path).lower().endswith('.parquet') else 'read_csv_auto(?,all_varchar=true)'
    try:
        with analysis_connection() as con:
            columns = {row[0] for row in con.execute('DESCRIBE SELECT * FROM '+reader, [str(path)]).fetchall()}
            aliases = [name for name in ['lineItem/UsageStartDate', 'line_item_usage_start_date'] if name in columns]
            if not aliases:
                return {'status': 'unavailable', 'reason': 'No supported usage date column'}
            dates = ['TRY_CAST("'+name+'" AS DATE)' for name in aliases]
            if len(dates) == 2 and con.execute('SELECT count(*) FROM '+reader+' WHERE '+dates[0]+' IS DISTINCT FROM '+dates[1], [str(path)]).fetchone()[0]:
                return {'status': 'unavailable', 'reason': 'Conflicting usage date columns'}
            count, first, last = con.execute('SELECT count(*),min('+dates[0]+'),max('+dates[0]+') FROM '+reader, [str(path)]).fetchone()
            return {'status': 'available' if first else 'unavailable', 'rows': count, 'min_date': str(first) if first else None, 'max_date': str(last) if last else None, 'notice': 'Observed bounds do not establish continuous coverage or export completeness'}
    except Exception:
        return {'status': 'unavailable', 'reason': 'Date inspection could not complete. Check format and available device resources.'}


def windows(first, last):
    first, last = date.fromisoformat(first), date.fromisoformat(last)
    if first > last:
        raise ValueError('Invalid observed date span')
    span = (last-first).days+1
    result = []
    for days in [7, 30, 90, 180]:
        if days > span:
            continue
        start = last-timedelta(days=days-1)
        end_baseline = start-timedelta(days=1)
        result.append({'days': days, 'start': str(start), 'end': str(last), 'baseline_start': str(min(first, end_baseline)), 'baseline_end': str(end_baseline), 'baseline_available': first < start})
    return result
