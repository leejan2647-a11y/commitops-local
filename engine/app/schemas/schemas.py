from __future__ import annotations
import uuid
from datetime import date, datetime
from typing import Any, Literal
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, computed_field
from typing_extensions import NotRequired, TypedDict


class SpendHistoryReason(BaseModel):
    code: str
    message: str
    recovery: str


class SpendHistoryWindow(BaseModel):
    start: date | None
    end: date | None
    days: StrictInt | None = Field(ge=1)
    observed_days: StrictInt | None = Field(ge=0)


class SpendHistoryDay(BaseModel):
    date: date
    amount_cents: StrictInt | None = Field(ge=-(2**53 - 1), le=2**53 - 1)
    observed_rows: StrictInt = Field(ge=0)


class SpendHistoryBaseline(BaseModel):
    status: Literal["available", "unavailable"]
    daily_average_cents: StrictInt | None = Field(ge=-(2**53 - 1), le=2**53 - 1)
    start: date | None
    end: date | None
    days: StrictInt | None = Field(ge=1)
    observed_days: StrictInt | None = Field(ge=0)
    source: Literal["selected_baseline_files", "in_file_history"] | None


class DashboardSpendHistory(BaseModel):
    """Immutable, source-observed daily facts, never completeness estimates."""

    check_id: uuid.UUID
    version: Literal["daily_spend_v1"] = "daily_spend_v1"
    status: Literal["available", "partial", "unavailable"]
    currency: Literal["USD"] | None
    basis: Literal["unblended"] = "unblended"
    population: Literal["selected_primary_files"] = "selected_primary_files"
    window: SpendHistoryWindow
    daily: list[SpendHistoryDay] = Field(default_factory=list)
    baseline: SpendHistoryBaseline
    source_formats: list[str] = Field(default_factory=list)
    total_cents: StrictInt | None = Field(ge=-(2**53 - 1), le=2**53 - 1)
    reconciliation_status: str
    delivery_completeness: Literal["unverified"] = "unverified"
    rounding: Literal["balanced_daily_cents"] = "balanced_daily_cents"
    reasons: list[SpendHistoryReason] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)


class CommitmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    #: The check the plan was observed in. None on an aggregate row (Task 5):
    #: a plan totalled across the tenant's history names no single check,
    #: and inventing one would be a lie a detail page could link to.
    check_id: uuid.UUID | None
    category: str
    name: str | None
    service: str | None
    #: Purchased (face) amount.
    amount_cents: int | None
    measurement: dict[str, Any] | None = None
    used_cents: int | None
    #: Computed server-side: max(purchased - used, 0); None when used is
    #: unknown - audit error 5: unknown is never a fabricated 0.
    unused_cents: int | None
    #: Computed server-side: used/purchased as a percentage, None when the
    #: plan's purchased amount is unknown (older rows).
    utilization_pct: float | None
    region: str | None
    account: str | None
    end_date: date | None
