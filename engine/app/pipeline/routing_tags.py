"""Nonfinancial routing metadata from the complete canonical primary scope."""
from app.pipeline.baseline import _group_names, _names
from app.pipeline.comparison import COMPARISON_FIELDS
from app.pipeline.ingest import TABLE, day_predicate
from app.pipeline.types import tag_columns


def capture(con, findings, window, columns, primary_where):
    tags = tag_columns(columns)[:64]
    if not tags or not findings:
        return
    # Only exported tags constant and nonempty throughout a finding's coarse
    # primary scope can assign its aggregate. Mixed tags do not imply an owner.
    projections, aggregates = [], []
    for i, tag in enumerate(tags):
        column = '"' + tag.replace('"', '""') + '"'
        projections.append(f"CAST({column} AS VARCHAR) AS tag_{i}")
        aggregates.extend([f"MIN(tag_{i})", f"MAX(tag_{i})", f"COUNT(tag_{i})"])
    group_names = _group_names(COMPARISON_FIELDS)
    inner = f"SELECT {_names(COMPARISON_FIELDS, columns)}, {', '.join(projections)} FROM {TABLE} WHERE ({primary_where}) AND {day_predicate(window.start, window.end)}"
    rows = con.execute(f"SELECT {group_names}, COUNT(*), {', '.join(aggregates)} FROM ({inner}) GROUP BY {group_names}").fetchall()
    by_group = {}
    for row in rows:
        values = {}
        for i, tag in enumerate(tags):
            minimum, maximum, count = row[5+i*3:8+i*3]
            if minimum and minimum == maximum and count == row[4] and len(minimum) <= 255:
                values[tag] = minimum
        by_group[tuple(str(v or "") for v in row[:4])] = values
    for finding in findings:
        finding.routing_tags = by_group.get(tuple(finding.coarse_key[:4]), {})
