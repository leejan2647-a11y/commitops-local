"""Local adapter. Financial computation stays in the extracted engine."""
import dataclasses
import enum
import hashlib
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from app.growth.contracts import GrowthSource
from app.pipeline.run import run_check
from app.pipeline.types import DataWindow, ServiceExpectation
from app.services.monthly_growth import compare_months


def serial(value):
    if hasattr(value, 'model_dump'):
        return value.model_dump(mode='json')
    if dataclasses.is_dataclass(value):
        return {field.name: serial(getattr(value, field.name)) for field in dataclasses.fields(value) if field.name != 'source'}
    if isinstance(value, dict):
        return {str(key): serial(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        return [serial(item) for item in value]
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def analyse(request, files, mappings):
    window = DataWindow(**{key: date.fromisoformat(request[key]) for key in ('start', 'end', 'baseline_start', 'baseline_end')})
    selected = request['files']
    if not isinstance(selected, list) or not selected or len(set(selected)) != len(selected):
        raise ValueError('Select distinct uploaded file identifiers')
    primary, baseline, sources = [], [], []
    ordered = sorted((files[item] for item in selected), key=lambda item: item['path'])
    # Canonical source ordinals follow the globally sorted union, regardless of role.
    for ordinal, item in enumerate(ordered):
        target = baseline if item['role'] == 'comparison' else primary
        target.append(item['path'])
        sources.append(GrowthSource(ordinal=ordinal, upload_id=item['id'], filename=item['name'], sha256=item['sha256'], role='baseline' if item['role'] == 'comparison' else 'primary'))
    if not primary:
        raise ValueError('At least one primary file is required')
    expectations = []
    for item in request.get('expectations', []):
        amount = item.get('amount')
        parsed = None if amount in (None, '') else Decimal(str(amount)) * 100
        if parsed is not None and (not parsed.is_finite() or parsed != parsed.to_integral_value() or abs(parsed) > 2**53-1):
            raise ValueError('Expected amounts require finite exact cents')
        expectations.append(ServiceExpectation(str(item['service'])[:255], str(item.get('note', ''))[:4096], None if parsed is None else int(parsed), parsed is None))
    from app.core.resources import analysis_connection
    with analysis_connection() as con:
        resource_budget = dict(con.hardware)
        result = run_check(primary, window, 'local', baseline_sources=baseline or None, expectations=expectations,
                           as_of=datetime.now(timezone.utc).date(), growth_sources=sources, growth_as_of=datetime.now(timezone.utc), con=con,
                           creep_monthly_growth_percent=request.get('_settings', {}).get('creepMonthlyGrowthPercent', '10'))
    output = serial(result)
    output['workspace_settings'] = dict(request.get('_settings', {}))
    output['resource_budget'] = resource_budget
    output['commitments'] = [{**serial(item), 'unused_cents': item.unused_cents}
                             for item in getattr(result, 'commitments', [])]
    # Team attribution joins only observed allocation; unknown consumption stays unknown.
    allocation = result.allocation.to_dict() if result.allocation is not None else None
    output['allocation'] = serial(allocation)
    observed = (allocation or {}).get('consumedByAccount') or {}
    output['teams'] = [{'account': account, 'team': mappings.get(account), 'consumed_cents': amount} for account, amount in observed.items()]
    output['input_files'] = [{key: item[key] for key in ('id', 'name', 'role', 'sha256', 'bytes')} for item in ordered]
    output['comparisons'] = []
    if result.monthly_growth:
        months = result.monthly_growth.observations
        for current in months:
            for baseline_month in months:
                if current.month > baseline_month.month:
                    output['comparisons'].append(serial(compare_months(current, baseline_month)))
    return output
