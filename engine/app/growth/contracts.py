"""Versioned, bounded monthly evidence and wire contracts."""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VERSION = 'monthly_growth_v1'
MAX_GROUPS = 10_000
MAX_SOURCES = 256
MAX_BYTES = 4 * 1024 * 1024
MAX_SAFE_CENTS = 2**53 - 1
NOTICE = ('Estimates use only the AWS data provided. Changes in cloud usage do not '
          'establish company or revenue growth. Missing exports, workload changes, '
          'discounts and billing adjustments can affect the result.')


def shift_month(month: date, offset: int) -> date:
    index = month.year * 12 + month.month - 1 + offset
    return date(index // 12, index % 12 + 1, 1)


def month_end(month: date) -> date:
    return date(month.year, month.month, calendar.monthrange(month.year, month.month)[1])


def utc(instant: datetime) -> datetime:
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError('A timezone-aware server instant is required')
    return instant.astimezone(timezone.utc)


@dataclass(frozen=True)
class GrowthPeriods:
    baseline: date
    previous: date
    current: date
    as_of: datetime

    @property
    def months(self) -> tuple[date, date, date]:
        return self.baseline, self.previous, self.current


def resolve_growth_periods(as_of: datetime) -> GrowthPeriods:
    instant = utc(as_of)
    current = instant.date().replace(day=1)
    return GrowthPeriods(shift_month(current, -2), shift_month(current, -1), current, instant)


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', validate_assignment=True)


class GrowthReason(Contract):
    code: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=1000)
    recovery: str = Field(min_length=1, max_length=1000)


def reason(code: str, message: str, recovery: str = 'Supply complete compatible original exports and run a new check.') -> GrowthReason:
    return GrowthReason(code=code, message=message, recovery=recovery)


def decimal_string(value: str) -> str:
    try:
        number = Decimal(value)
        if not number.is_finite() or abs(number) >= Decimal('1e28') or len(value) > 180:
            raise ValueError('Unsupported decimal magnitude')
    except (InvalidOperation, TypeError) as exc:
        raise ValueError('A finite decimal string is required') from exc
    return value


class GrowthSource(Contract):
    ordinal: int = Field(ge=0)
    upload_id: UUID
    filename: str = Field(min_length=1, max_length=512)
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    role: Literal['primary', 'baseline']
    raw_rows: int = Field(default=0, ge=0)
    canonical_rows: int = Field(default=0, ge=0)
    removed_copy_rows: int = Field(default=0, ge=0)


class GrowthGroup(Contract):
    # payer/account/service/region/usage-type/operation/SKU/unit/line-item-type
    key: tuple[str, str, str, str, str, str, str, str, str]
    quantity: str | None = None
    charge_cents: str
    rows: int = Field(ge=1)
    source_ordinals: list[int] = Field(default_factory=list, max_length=MAX_SOURCES)
    valid: bool = True

    @field_validator('quantity', 'charge_cents')
    @classmethod
    def valid_decimal(cls, value):
        return decimal_string(value) if value is not None else value

    @field_validator('key')
    @classmethod
    def bounded_key(cls, values):
        if any(len(value) > 1024 or '\x00' in value for value in values):
            raise ValueError('Unsupported group dimension')
        return values


class GrowthMonthObservation(Contract):
    observation_id: UUID = Field(default_factory=uuid4)
    check_id: UUID | None = None
    month: date
    role: Literal['primary', 'baseline'] = 'primary'
    version: Literal['monthly_growth_v1'] = VERSION
    basis: Literal['unblended'] = 'unblended'
    currency: Literal['USD'] | None = None
    captured_at: datetime
    latest_source_at: datetime | None = None
    status: Literal['available', 'partial', 'unavailable'] = 'unavailable'
    complete: bool = False
    explicit_baseline: bool = False
    source_digest: str = Field(default='0'*64, pattern=r'^[0-9a-f]{64}$')
    scope_hash: str = Field(default='0'*64, pattern=r'^[0-9a-f]{64}$')
    basket_hash: str = Field(default='0'*64, pattern=r'^[0-9a-f]{64}$')
    account_scope: list[str] = Field(default_factory=list, max_length=10_000)
    payer_scope: list[str] = Field(default_factory=list, max_length=10_000)
    charge_cents: int | None = Field(default=None, ge=-MAX_SAFE_CENTS, le=MAX_SAFE_CENTS, strict=True)
    exact_charge_cents: str | None = None
    observed_days: list[date] = Field(default_factory=list, max_length=31)
    missing_days: list[date] = Field(default_factory=list, max_length=31)
    raw_rows: int = Field(default=0, ge=0)
    canonical_rows: int = Field(default=0, ge=0)
    removed_copy_rows: int = Field(default=0, ge=0)
    sources: list[GrowthSource] = Field(default_factory=list, max_length=MAX_SOURCES)
    groups: list[GrowthGroup] = Field(default_factory=list, max_length=MAX_GROUPS)
    usage_group_count: int = Field(default=0,ge=0,le=MAX_GROUPS)
    usage_samples: list[GrowthGroup] = Field(default_factory=list, max_length=20)
    reasons: list[GrowthReason] = Field(default_factory=list, max_length=40)
    delivery_completeness: Literal['unverified'] = 'unverified'

    @field_validator('captured_at', 'latest_source_at')
    @classmethod
    def aware(cls, value):
        return utc(value) if value is not None else None

    @field_validator('month')
    @classmethod
    def first_day(cls, value):
        if value.day != 1:
            raise ValueError('Month must start on the first day')
        return value

    @field_validator('exact_charge_cents')
    @classmethod
    def finite_charge(cls, value):
        return decimal_string(value) if value is not None else None

    @model_validator(mode='after')
    def calendar_invariants(self):
        if self.complete and (self.status != 'available' or self.missing_days
                              or self.captured_at.date() <= month_end(self.month)):
            raise ValueError('An incomplete/open month cannot be complete')
        if len(set(self.observed_days)) != len(self.observed_days):
            raise ValueError('Duplicate coverage dates')
        return self


class GrowthCapture(Contract):
    version: Literal['monthly_growth_v1'] = VERSION
    captured_at: datetime
    observations: list[GrowthMonthObservation] = Field(default_factory=list, max_length=10)
    reasons: list[GrowthReason] = Field(default_factory=list, max_length=40)


class GrowthDriver(Contract):
    key: tuple[str, ...]
    baseline_daily_quantity: str
    current_daily_quantity: str
    usage_change_percent: str
    weight_percent: str


class GrowthComparison(Contract):
    status: Literal['available', 'unavailable'] = 'unavailable'
    comparison_id: str | None = None
    observation_id: UUID | None = None
    baseline_observation_id: UUID | None = None
    baseline_check_id: UUID | None = None
    baseline_month: date | None = None
    spending_delta_cents: int | None = Field(default=None, ge=-MAX_SAFE_CENTS, le=MAX_SAFE_CENTS)
    spending_change_percent: str | None = None
    usage_change_percent: str | None = None
    represented_groups: int = 0
    excluded_groups: int = 0
    other_driver_count: int = 0
    drivers: list[GrowthDriver] = Field(default_factory=list, max_length=20)
    reasons: list[GrowthReason] = Field(default_factory=list, max_length=40)


class GrowthUsageView(Contract):
    key: tuple[str, ...]
    quantity: str | None
    unit: str
    valid: bool
    source_upload_ids: list[UUID] = Field(default_factory=list,max_length=MAX_SOURCES)


class GrowthPeriodView(Contract):
    observation_id: UUID
    check_id: UUID
    month: date
    start: date
    end: date
    kind: Literal['previous','current','historical']
    status: Literal['available','partial','unavailable']
    complete: bool
    currency: Literal['USD'] | None
    basis: Literal['unblended'] = 'unblended'
    charge_cents: int | None
    captured_at: datetime
    latest_source_at: datetime | None
    observed_days: list[date]
    missing_days: list[date]
    sources: list[GrowthSource]
    raw_rows: int
    canonical_rows: int
    removed_copy_rows: int
    delivery_completeness: Literal['unverified'] = 'unverified'
    usage_observations: list[GrowthUsageView]
    usage_group_count: int
    comparison: GrowthComparison
    reasons: list[GrowthReason]


class GrowthDashboardResponse(Contract):
    version: Literal['monthly_growth_v1'] = VERSION
    check_id: UUID
    view_as_of: datetime
    calculated_at: datetime
    status: Literal['available','unavailable','preparing'] = 'unavailable'
    periods: list[GrowthPeriodView] = Field(default_factory=list,max_length=3)
    reasons: list[GrowthReason] = Field(default_factory=list,max_length=40)
    notice: str = NOTICE
    can_prepare: bool = False


class GrowthPrepareRequest(Contract):
    check_id: UUID
    comparison_check_id: UUID | None = None
