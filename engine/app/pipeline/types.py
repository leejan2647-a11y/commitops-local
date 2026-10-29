"""Shared vocabulary for the CommitOps billing pipeline.

This module is the single source of truth for the CUR 1.0/2.0 column contract, the
detector taxonomy, and the result types that flow out of steps 1-6.

Design rules that the rest of the pipeline depends on:

* **Money is never a float.** All monetary values are :class:`decimal.Decimal`
  internally retain supported source precision. Reported monetary fields become
  integer cents at explicit HALF_UP boundaries.
* **Finding ids are deterministic.** A finding re-derived from the same input
  window gets the same id, so re-running a check is idempotent and a retry
  cannot duplicate rows.
* **Nothing here raises on bad data.** A file that fails validation still returns
  a :class:`ValidationReport`; it is the caller's job to decide whether to
  continue. Validation never silently swallows a discrepancy either.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from enum import Enum

# --------------------------------------------------------------------------
# Money
# --------------------------------------------------------------------------

#: Exact fixed-point scale for all money. 1 unit = 1 cent.
CENTS = Decimal("0.01")
ZERO = Decimal("0.00")


def to_cents(value: object) -> int:
    """Convert a CUR cost/amount to integer cents.

    Accepts whatever DuckDB hands back (``Decimal``, ``float``, ``int``,
    ``str``). CUR files store costs as text, so ``str`` is the common case.
    Uses the application's explicit HALF_UP reporting policy.
    """
    if value is None:
        return 0
    if isinstance(value, Decimal):
        dec = value
    elif isinstance(value, int):
        dec = Decimal(value)
    else:
        dec = Decimal(str(value))
    if not dec.is_finite():
        return 0
    return int((dec * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def from_cents(cents: int) -> Decimal:
    """Convert integer cents back to a cents-quantized ``Decimal``."""
    return (Decimal(cents) / 100).quantize(CENTS, rounding=ROUND_HALF_UP)


# --------------------------------------------------------------------------
# CUR 2.0 column contract
# --------------------------------------------------------------------------
# Names are the real CUR 2.0 header keys, including the ``prefix/Field``
# convention. A file missing any REQUIRED column is not a CUR 2.0 export and we
# refuse to analyse it rather than guess at column meanings.

#: Columns without which no analysis is possible.
REQUIRED_COLUMNS: frozenset[str] = frozenset(
    {
        "identity/LineItemId",
        "lineItem/UsageStartDate",
        "lineItem/UsageEndDate",
        "lineItem/UsageAccountId",
        "lineItem/LineItemType",
        "lineItem/UsageType",
        "lineItem/Operation",
        "lineItem/UnblendedCost",
        "lineItem/CurrencyCode",
    }
)

#: Columns that unlock specific detectors. Absent -> that detector reports
#: itself as "unavailable" rather than silently returning zero findings.
OPTIONAL_COLUMNS: frozenset[str] = frozenset(
    {
        # usage-to-cost mismatch
        "lineItem/UsageAmount",
        "lineItem/NormalizedUsageAmount",
        # grouping + attribution
        "lineItem/ResourceId",
        "lineItem/AvailabilityZone",
        "product/Region",
        "product/ProductName",
        "product/ProductFamily",
        "product/InstanceType",
        # service attribution (Feature 1.6). AWS gives a service several names:
        # ServiceCode is the short machine code (AmazonEC2), ProductCode the
        # line-item level code, ProductName the long display name. CUR 2.0
        # publishes the first two as flat columns but collapses ProductName
        # into a map column a flat CSV cannot expose - so a genuine CUR 2.0
        # upload arrives with no display name at all, and the service slot of
        # the grouping used to come back empty. See baseline.SERVICE_CHAIN.
        "product/ServiceCode",
        "lineItem/ProductCode",
        # commitment math
        "savingsPlan/SavingsPlanId",
        "savingsPlan/SavingsPlanType",
        "savingsPlan/PaymentOption",
        "savingsPlan/TotalCommitmentToDate",
        "savingsPlan/UsedCommitment",
        "reservation/ReservationId",
        "reservation/TotalReservedUnits",
        "reservation/UsedReservationUnits",
        "reservation/NormalizedUnitsPerReservation",
        # marketplace detector
        "marketplace/ProviderName",
        "marketplace/ProductName",
        # discounts / credits
        "discount/Deduction",
        "lineItem/DiscountAmount",
        "lineItem/NetUnblendedCost",
        "bill/BillingPeriodStartDate",
        "bill/BillingPeriodEndDate",
        "bill/BillType",
        "bill/BillingEntity",
    }
)

# --------------------------------------------------------------------------
# CUR 2.0 (AWS Data Exports) column names
# --------------------------------------------------------------------------
# AWS ships two real, supported billing-export shapes and they name the same
# facts differently:
#
#   * the **classic** Cost and Usage Report, whose headers use the
#     ``prefix/Field`` convention (``lineItem/UnblendedCost``);
#   * **CUR 2.0** proper - the ``COST_AND_USAGE_REPORT`` table behind AWS Data
#     Exports - which uses flat ``snake_case`` headers (``line_item_unblended_cost``)
#     and, per AWS, "a fixed set of columns".
#
# Requiring only the classic names therefore rejected genuine CUR 2.0 exports:
# a file straight out of the AWS console was refused for "missing 9 required
# CUR 2.0 column(s)" while actually being one. The nine REQUIRED columns are
# all flat top-level columns in CUR 2.0, so accepting both spellings is a
# rename; the internal contract stays the classic one, so no detector, the row
# hash, or the database changes.
#
# Two AWS quirks are encoded here rather than derived mechanically, because
# deriving them is exactly how a wrong column name gets shipped:
#   * ARN is snake-cased per initial, not per word: ``..._a_r_n``.
#   * the Savings Plan *type* column is called ``offering_type`` in CUR 2.0.
#
# Deliberately NOT mapped, because CUR 2.0 collapses them into map columns that
# a flat CSV cannot expose as separate headers: ``product/ProductName`` and the
# ``tags/*`` columns (CUR 2.0 nests them under the ``product`` and ``tags``
# map columns). Detectors that need those already report themselves
# "unavailable" when a column is absent, so they degrade honestly instead of
# silently reporting zeros.
CUR2_COLUMN_ALIASES: dict[str, str] = {
    # -- identity --
    "identity_line_item_id": "identity/LineItemId",
    "identity_time_interval": "identity/TimeInterval",
    # -- lineItem: the nine REQUIRED columns --
    "line_item_usage_start_date": "lineItem/UsageStartDate",
    "line_item_usage_end_date": "lineItem/UsageEndDate",
    "line_item_usage_account_id": "lineItem/UsageAccountId",
    "line_item_line_item_type": "lineItem/LineItemType",
    "line_item_usage_type": "lineItem/UsageType",
    "line_item_operation": "lineItem/Operation",
    "line_item_unblended_cost": "lineItem/UnblendedCost",
    "line_item_currency_code": "lineItem/CurrencyCode",
    # -- lineItem: optional, still flat in CUR 2.0 --
    "line_item_usage_amount": "lineItem/UsageAmount",
    "line_item_normalized_usage_amount": "lineItem/NormalizedUsageAmount",
    "line_item_resource_id": "lineItem/ResourceId",
    "line_item_availability_zone": "lineItem/AvailabilityZone",
    "line_item_net_unblended_cost": "lineItem/NetUnblendedCost",
    "line_item_line_item_description": "lineItem/LineItemDescription",
    # -- product: CUR 2.0 spells the region column *_region_code --
    "product_region_code": "product/Region",
    "product_servicecode": "product/ServiceCode",
    "product_product_family": "product/ProductFamily",
    "product_instance_type": "product/InstanceType",
    "product_instance_family": "product/InstanceFamily",
    "product_sku": "product/Sku",
    "product_operation": "product/Operation",
    "product_pricing_unit": "product/PricingUnit",
    "product_usagetype": "product/UsageType",
    # line_item_product_code is flat in CUR 2.0 and carries the service code
    # at the line-item level - the best service attribution a CUR 2.0 export
    # has, because its product map column cannot reach a flat CSV.
    "line_item_product_code": "lineItem/ProductCode",
    # -- reservation --
    "reservation_reservation_a_r_n": "reservation/ReservationId",
    "reservation_total_reserved_units": "reservation/TotalReservedUnits",
    "reservation_normalized_units_per_reservation": "reservation/NormalizedUnitsPerReservation",
    "reservation_number_of_reservations": "reservation/NumberOfReservations",
    # Unit metadata is retained, but is not a monetary valuation basis.
    "reservation_unused_quantity": "reservation/UnusedQuantity",
    # EffectiveCost belongs to DiscountedUsage. RIFee supplies the monthly
    # unused recurring/upfront components and the independent fee control.
    "reservation_effective_cost": "reservation/EffectiveCost",
    "reservation_unused_recurring_fee": "reservation/UnusedRecurringFee",
    "reservation_unused_amortized_upfront_fee_for_billing_period": "reservation/UnusedAmortizedUpfrontFeeForBillingPeriod",
    "reservation_amortized_upfront_fee_for_billing_period": "reservation/AmortizedUpfrontFeeForBillingPeriod",
    "reservation_amortized_upfront_cost_for_usage": "reservation/AmortizedUpfrontCostForUsage",
    "reservation_recurring_fee_for_usage": "reservation/RecurringFeeForUsage",
    "reservation_start_time": "reservation/StartTime",
    "reservation_end_time": "reservation/EndTime",
    # -- savingsPlan: interval coverage and beneficiary evidence --
    "savings_plan_start_time": "savingsPlan/StartTime",
    "savings_plan_end_time": "savingsPlan/EndTime",
    "savings_plan_savings_plan_effective_cost": "savingsPlan/SavingsPlanEffectiveCost",
    "bill_payer_account_id": "bill/PayerAccountId",
    # -- savingsPlan --
    "savings_plan_savings_plan_a_r_n": "savingsPlan/SavingsPlanId",
    "savings_plan_offering_type": "savingsPlan/SavingsPlanType",
    "savings_plan_payment_option": "savingsPlan/PaymentOption",
    "savings_plan_total_commitment_to_date": "savingsPlan/TotalCommitmentToDate",
    "savings_plan_used_commitment": "savingsPlan/UsedCommitment",
    # -- bill --
    "bill_billing_period_start_date": "bill/BillingPeriodStartDate",
    "bill_billing_period_end_date": "bill/BillingPeriodEndDate",
    "bill_bill_type": "bill/BillType",
    "bill_invoice_id": "bill/InvoiceId",
    "bill_billing_entity": "bill/BillingEntity",
}


CUR1_COLUMN_ALIASES: dict[str, str] = {
    "savingsPlan/SavingsPlanArn": "savingsPlan/SavingsPlanId",
    "savingsPlan/SavingsPlanARN": "savingsPlan/SavingsPlanId",
    "savingsPlan/OfferingType": "savingsPlan/SavingsPlanType",
    "reservation/ReservationARN": "reservation/ReservationId",
    # Athena's legacy mixed-Arn column differs from Data Exports' A_R_N.
    "savings_plan_savings_plan_arn": "savingsPlan/SavingsPlanId",
    "reservation_reservation_arn": "reservation/ReservationId",
    "product_region": "product/Region",
    "product_regioncode": "product/Region",
    "product_product_name": "product/ProductName",
    "product_instance_type_family": "product/InstanceFamily",
    "product/regioncode": "product/Region",
    "product/region": "product/Region",
    "product/servicecode": "product/ServiceCode",
    "product/instanceType": "product/InstanceType",
    "product/instanceTypeFamily": "product/InstanceFamily",
    "product/productFamily": "product/ProductFamily",
}
COLUMN_ALIASES = {**CUR2_COLUMN_ALIASES, **CUR1_COLUMN_ALIASES}


def canonical_column(name: str, columns) -> str:
    """Resolve documented field spellings; retain customer tag key case.

    Product region fields carry region codes. Both spellings must agree when
    supplied; human location labels are separate metadata, not code aliases.
    """
    if name.startswith("resourceTags/user:"):
        return "tags/user:" + name[len("resourceTags/user:"):]
    if name.startswith("resource_tags_user_"):
        # Athena preserves a normalized tag suffix; its original punctuation
        # and case cannot be recovered, so retain exactly what was supplied.
        return "tags/user:" + name[len("resource_tags_user_"):]
    return COLUMN_ALIASES.get(name, name)


def is_cur2(columns: frozenset[str] | set[str]) -> bool:
    """True when these headers are CUR 2.0 snake_case rather than classic CUR.

    Decided by the presence of at least one known alias and the absence of any
    classic ``prefix/Field`` header, so a classic file is never misread.

    The slash test skips ``tags/user:*`` on purpose. Tag headers contain a slash
    in both shapes, so counting them would reject a perfectly good CUR 2.0 file
    whose tags arrived as columns - which is exactly what happens when a real
    export is round-tripped through a tool that flattens the nested ``tags``
    map. Only the other prefixes (``lineItem/``, ``product/``, ...) carry the
    classic convention.
    """
    remaining = [c for c in columns if not c.startswith((TAG_PREFIX, "resourceTags/user:", "resource_tags_user_"))]
    if any("/" in c for c in remaining):
        return False
    return any(c in CUR2_COLUMN_ALIASES for c in remaining)


#: ``tags/user:*`` are variable by nature; we detect their presence by prefix.
TAG_PREFIX = "tags/user:"


def tag_columns(available: frozenset[str] | set[str]) -> list[str]:
    """Return the customer-defined tag columns present in a CUR file."""
    return sorted(c for c in available if c.startswith((TAG_PREFIX, "resourceTags/user:", "resource_tags_user_")))


# --------------------------------------------------------------------------
# Detector taxonomy
# --------------------------------------------------------------------------


class DetectorType(str, Enum):
    """The detectors that run during a check.

    Eight detectors. Note this supersedes the "7 detectors" figure used in
    earlier planning docs: the authoritative list is the one in the product
    brief, and the expectation detector replaced the old "expected-free-tier
    violation" entry, which could never have been computed from CUR data alone.

    Values are the wire format and must match the frontend exactly. They are
    kebab-case; the frontend's existing mock-data union uses different strings
    (``gradual-increase``, ``commitment-waste``, ``unusual-resource``) and must
    be reconciled when the frontend is wired up.
    """

    UNEXPECTED_CHARGE = "unexpected-charge"
    SPIKE = "spike"
    GRADUAL_CREEP = "gradual-creep"
    NEW_CHARGE = "new-charge"
    USAGE_COST_MISMATCH = "usage-cost-mismatch"
    MARKETPLACE = "marketplace"
    EXPECTATION_MISMATCH = "expectation-mismatch"
    UNUSED_COMMITMENT = "unused-commitment"


#: Human-readable labels. Used in finding titles and in the API, never in logic.
DETECTOR_LABELS: dict[DetectorType, str] = {
    DetectorType.UNEXPECTED_CHARGE: "Unexpected charge",
    DetectorType.SPIKE: "Cost spike",
    DetectorType.GRADUAL_CREEP: "Gradual cost creep",
    DetectorType.NEW_CHARGE: "New charge",
    DetectorType.USAGE_COST_MISMATCH: "Usage-to-cost mismatch",
    DetectorType.MARKETPLACE: "Marketplace charge",
    DetectorType.EXPECTATION_MISMATCH: "Expectation mismatch",
    DetectorType.UNUSED_COMMITMENT: "Unused commitment",
}

#: Detectors that cannot run without a column the file may not contain.
DETECTOR_OPTIONAL_COLUMNS: dict[DetectorType, tuple[str, ...]] = {
    DetectorType.USAGE_COST_MISMATCH: (
        "lineItem/UsageAmount",
        "lineItem/NormalizedUsageAmount",
    ),
    DetectorType.MARKETPLACE: ("marketplace/ProviderName", "marketplace/ProductName"),
    DetectorType.UNUSED_COMMITMENT: ("savingsPlan/SavingsPlanId", "reservation/ReservationId"),
}


class Severity(str, Enum):
    """Ordering matters: :func:`severity_rank` is used for sorting."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

    @property
    def rank(self) -> int:
        return _SEVERITY_RANK[self]


_SEVERITY_RANK: dict[Severity, int] = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.LOW: 3,
}


class FindingStatus(str, Enum):
    OPEN = "open"
    INVESTIGATING = "investigating"
    RESOLVED = "resolved"


# --------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DataWindow:
    """The period being analysed, and the prior period used as the baseline.

    The baseline window must not overlap the check window: including it is how
    a detector ends up explaining a spike with the spike itself.
    """

    start: date
    end: date
    baseline_start: date
    baseline_end: date

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ValueError("check window start is after its end")
        if self.baseline_start > self.baseline_end:
            raise ValueError("baseline window start is after its end")
        # The baseline must end strictly before the check window starts.
        # Checking only `baseline_start >= start` is not enough: a baseline that
        # *begins* early but *ends inside* the check window still overlaps it,
        # and would let a detector explain a spike with the spike itself.
        if self.baseline_end >= self.start:
            raise ValueError(
                "baseline window must end before the check window starts, "
                "otherwise the baseline is contaminated by the data under test "
                f"(baseline ends {self.baseline_end}, check starts {self.start})"
            )

    @property
    def check_days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def baseline_days(self) -> int:
        return (self.baseline_end - self.baseline_start).days + 1


@dataclass(frozen=True)
class ServiceExpectation:
    """A customer's stated expectation about one service, for one check.

    Carries both halves of the user's requirement: the free-text note the
    customer typed, and a machine-usable number if one could be extracted from
    it. ``stated_amount_cents`` is ``None`` when the text contains no parseable
    figure, and in that case the detector cannot compute a variance and says so
    rather than guessing.
    """

    service: str
    note: str
    stated_amount_cents: int | None = None
    #: True when the note was written but no amount could be read from it.
    unparsed: bool = False


@dataclass(frozen=True)
class CoarseBaselineRow:
    """One coarse group's daily p95, persisted per check in ``baselines``.

    The baselines table exists so a finding's *normal* is recoverable after the
    DuckDB connection that computed it is gone: ``Finding.normal_cents`` is
    detector-specific (a daily p95 for one detector, a whole-window total for
    another), while this row is always the group's own daily p95.
    """

    coarse_key: tuple[str, ...]
    daily_p95_cents: int


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------


@dataclass
class EvidenceSummary:
    """Step 5. What the billing rows themselves account for.

    The product rule is that we never state a variance we cannot source. So
    every finding carries the sum of the rows that produced it, and any
    shortfall is reported as an explicit remainder instead of being absorbed.
    """

    evidence_total: Decimal
    line_item_count: int
    #: Rows that carried the largest share of the impact, for the UI to show.
    top_line_items: list[dict] = field(default_factory=list)
    #: Rows the finding pointed at that had no cost (context, not contribution).
    zero_cost_line_items: int = 0
    source_row_count: int | None = None
    raw_positive_row_count: int | None = None
    displayed_contribution_cents: int | None = None
    explained_not_displayed_cents: int | None = None
    impact_comparison: dict | None = None
    scope: str = "full_window_positive_excess"
    period: dict | None = None


@dataclass
class Finding:
    """A candidate anomaly.

    ``impact_cents`` is the money the customer could plausibly act on. It is
    the *excess over normal*, not the raw total, and never exceeds the evidence
    that supports it.
    """

    id: str
    type: DetectorType
    title: str
    description: str
    severity: Severity
    status: FindingStatus = FindingStatus.OPEN

    service: str = ""
    account: str = ""
    region: str = ""
    resource: str = ""
    usage_type: str = ""

    #: The grouping this finding was *measured* at, in
    #: ``app.pipeline.comparison.COMPARISON_FIELDS`` order
    #: (service, account, region, usage type).
    #:
    #: It is recorded here rather than re-derived by the orchestrator because
    #: ``Finding`` deliberately does not carry ``operation`` or
    #: ``line_item_type``, so the measurement grain cannot be reconstructed from
    #: the other fields. Getting it wrong is the bug this prevents: evidence
    #: gathered at a different grain than the finding selects the wrong rows, and
    #: an evidence total of zero next to a non-zero impact is worse than no
    #: evidence card at all. Empty means "not measured against a grouping" (e.g.
    #: a data-source level check), and evidence is then skipped honestly rather
    #: than guessed at.
    coarse_key: tuple[str, ...] = ()

    impact_cents: int = 0
    normal_cents: int = 0
    delta_percent: Decimal = ZERO

    detected_at: datetime | None = None
    first_seen: datetime | None = None

    #: Verbatim input that produced this finding, for auditability.
    evidence: EvidenceSummary | None = None
    #: The detector's own reasoning, including the statistics behind it.
    stats: dict = field(default_factory=dict)
    #: Nonfinancial exact exported tag values; mixed/missing scopes omitted.
    routing_tags: dict[str, str] = field(default_factory=dict)
    amount_measurement: dict | None = None
    #: Non-fatal problems, e.g. an expectation that could not be parsed.
    caveats: list[str] = field(default_factory=list)

    #: The fields that must always hold a whole number of cents.
    _MONEY = ("impact_cents", "normal_cents")

    def __post_init__(self) -> None:
        """Hold the money fields to whole cents.

        ``impact_cents`` and ``normal_cents`` are typed ``int`` and the rest of
        the pipeline treats them that way: they are summed into report totals,
        compared for persistence, and rendered as currency. A Python annotation
        is not enforcement, though, and one detector passing a float is enough
        to put ``4000.0`` in front of a customer - it renders with a decimal
        point, a database integer column rounds it by its own rules, and the
        remainder arithmetic silently inherits the float.

        This check exists because that already happened. ``detect_spike``
        derives a trailing mean with ``sum(history) / len(history)``, which is a
        float, and passed the resulting excess straight through. The detector
        tests passed, because they compared cents against cents and a float
        compares fine.

        Exactly-integral floats are accepted and narrowed, because ``4000.0``
        carries no money error and refusing it would only push callers to write
        ``int()`` at the call site - which is precisely where truncation silently
        drops money. A float with a fractional part is refused instead: the
        precision was already lost upstream, and rounding here would pick a
        number that nobody chose. ``int()`` truncates; it does not round, so a
        value of 3999.7 would become 3999 - a cent of spend that vanishes
        between the detector and the invoice.

        :raises TypeError: a money field was given something that is not a
            number, or a float that is not a whole number of cents.
        """
        for name in self._MONEY:
            value = getattr(self, name)
            # bool is an int subclass, and True is not a plausible amount.
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(
                    f"Finding.{name} must be whole cents, got {type(value).__name__}: {value!r}"
                )
            if isinstance(value, float):
                if not value.is_integer():
                    raise TypeError(
                        f"Finding.{name} must be whole cents, got {value!r}: the precision "
                        f"was lost before the finding was built. Round it at the point of "
                        f"calculation with app.pipeline.types.to_cents, which rounds "
                        f"with the application HALF_UP policy."
                    )
                setattr(self, name, int(value))

    @property
    def amount(self) -> Decimal:
        return from_cents(self.impact_cents)

    @property
    def normalAmount(self) -> Decimal:
        return from_cents(self.normal_cents)

    @property
    def unexplained_remainder(self) -> Decimal:
        """Impact the evidence does not account for.

        Zero when there is no evidence attached. Never negative: if the evidence
        overshoots the impact we keep the evidence and report a remainder of 0,
        because an over-explained finding is not a discrepancy worth flagging.
        """
        if self.evidence is None:
            return ZERO
        gap = self.impact_cents - int(self.evidence.evidence_total * 100)
        return from_cents(max(gap, 0))


def make_finding_id(
    tenant_id: str,
    detector: DetectorType,
    key: str,
    window_start: date,
    window_end: date,
) -> str:
    """Build a stable, opaque finding id.

    Deterministic so that re-processing the same window yields the same id and
    upserts instead of duplicating. Opaque so the frontend cannot infer anything
    about the customer's account ids from the id.

    ``key`` must identify the finding *uniquely*, which is a stronger requirement
    than it looks. A display label is not enough: the coarse grain that detectors
    compare at spans several accounts and regions, and a label built from service
    and usage type alone is identical for all of them. Ids then collide, and since
    this id is the upsert key, one account's finding silently overwrites another's
    at persistence time. Pass the full grouping tuple, not a human-readable label.
    """
    seed = f"{tenant_id}|{detector.value}|{key}|{window_start}|{window_end}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]
    return str(uuid.UUID(hex=digest))


def content_hash(values: object) -> str:
    """Deterministic hash of a row's identity, for duplicate detection."""
    return hashlib.sha256(repr(values).encode("utf-8")).hexdigest()
