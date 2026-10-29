"""Step 6 - the commitment math.

Savings Plans and Reserved Instances are prepaid. The product question is never
"did I buy it" but "did I get what I paid for", so this module answers three
things per commitment: how much was **purchased**, how much was **consumed**,
and how much is **unused** - then splits the unused portion into the categories
the Allocation page shows.

Two rules the implementation holds to:

* **Never negative.** A commitment that appears over-used (more consumed than
  purchased, which happens with overages and exchange) reports 0 unused and
  carries a caveat. Clamping at zero silently would hide a real billing problem.
* **Unused is not waste.** Unused commitment is reported as money already spent
  that produced no value. It is *not* attributed to a team that had no way to
  know the commitment existed, unless the data actually shows who used it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

import duckdb

from app.pipeline import savings_plans as SP
from app.pipeline.ingest import COST_CENTS_SQL, TABLE, day_predicate, resolve_role_scope, text
from app.pipeline.types import DetectorType, Finding, Severity, make_finding_id

log = logging.getLogger(__name__)

#: --- Commitment-waste thresholds (Task 4) ------------------------------------
#: A commitment is flagged as waste when BOTH hold, so a nearly-exhausted
#: plan with a rounding-level remainder stays quiet and a cheap, mostly
#: unused one still gets said:

#: utilisation is below this target (bought and mostly not drawn on) ...
WASTE_UTILISATION_TARGET: Decimal = Decimal("0.80")
#: ... and the unused balance is at least this many cents (the same $1
#: materiality floor every detector uses).
UNUSED_MIN_CENTS = 100  # $1

#: The Allocation page's five categories. Kept here because this is the only
#: place the split is computed; the frontend renders the same five.
ALLOCATION_CATEGORIES = (
    "unused",              # bought, never consumed
    "underutilised",       # partially consumed
    "unallocated",         # consumed by something we cannot attribute
    "expired",             # term ended with unused balance
    "mismatched-region",   # consumed outside the region it was bought for
)

# These diagnoses need an agreed historical-window/as-of policy and a
# validated link between unused balance and term/region evidence. CUR2 may
# include term dates and RI ARNs; their presence alone does not assign dollars
# to either diagnosis. Keep the unsupported categories unavailable, not zero.
# Non-derivable remains the wire key for compatibility; it means that the
# product has not assessed a diagnosis, not that source fields are absent.
UNASSESSED_ALLOCATION_CATEGORIES = ("expired", "mismatched-region")


def _arn_region(identifier: str) -> str:
    """The region an ARN names, or ``''`` when it names none.

    A regional Reserved Instance ARN carries its region in slot 3
    (``arn:aws:ec2:us-east-1:111111111111:reserved-instances/...``); Savings
    Plan ARNs leave the slot empty
    (``arn:aws:savingsplans::111111111111:savingsplan/...``). Only a non-empty
    slot 3 of a real ``arn:`` prefix is claimed as a region - anything else
    returns ``''`` rather than a guess.
    """
    parts = identifier.split(":")
    if len(parts) < 6 or parts[0] != "arn":
        return ""
    return parts[3]


@dataclass
class CommitmentSummary:
    """Purchased vs consumed for one commitment."""

    id: str
    type: str  # 'savings-plan' | 'reserved-instance'
    service: str
    name: str
    purchased_cents: int | None
    used_cents: int | None
    region: str = ""
    account: str = ""
    end_date: date | None = None
    measurement_json: dict | None = None

    @property
    def unused_cents(self) -> int | None:
        """Never negative; an over-used commitment reports 0 and is flagged."""
        if self.measurement_json:
            return self.measurement_json["metrics"]["unused"]["value_cents"]
        if self.purchased_cents is None or self.used_cents is None:
            return None
        return max(self.purchased_cents - self.used_cents, 0)

    @property
    def over_used_cents(self) -> int:
        if self.purchased_cents is None or self.used_cents is None:
            return 0
        return max(self.used_cents - self.purchased_cents, 0)

    @property
    def utilization(self) -> Decimal | None:
        if self.measurement_json:
            value = self.measurement_json["metrics"]["utilization"]["value"]
            return Decimal(value) if value is not None else None
        if self.purchased_cents is None or self.used_cents is None:
            return None
        if self.purchased_cents <= 0:
            return Decimal(0)
        return (Decimal(self.used_cents) / Decimal(self.purchased_cents)).quantize(
            Decimal("0.0001")
        )

    @property
    def coverage(self) -> Decimal:
        """Alias used by the frontend Commitment shape."""
        return self.utilization

    def category(self) -> str:
        if self.measurement_json:
            used = self.measurement_json["metrics"]["used"].get("exact")
            return "unused" if used is not None and Decimal(used) == 0 else "underutilised"
        if self.unused_cents is None or self.unused_cents <= 0:
            return "underutilised"
        if self.type == "reserved-instance":
            # The ARN names the region the reservation was bought for; the
            # summary's region is where its usage rows were actually consumed.
            # When they differ, the unused balance is money stranded in the
            # wrong region - the actionable insight is the mismatch, not
            # "use your reservation more", so it gets its own category.
            purchased_region = _arn_region(self.id)
            if purchased_region and purchased_region != self.region:
                return "mismatched-region"
        if self.used_cents is not None and self.used_cents <= 0:
            return "unused"
        return "underutilised"


@dataclass
class AllocationSplit:
    """Unused commitment money, divided up for the Allocation page."""

    total_unused_cents: int | None = 0
    by_category: dict[str, int] = field(default_factory=dict)
    #: account -> cents of *consumed* commitment, for shared-plan attribution.
    consumed_by_account: dict[str, int] = field(default_factory=dict)
    #: Categories not assessed by the supported classification rules, so the
    #: UI shows unavailable instead of implying a checked-and-zero $0. The money
    #: that cannot be categorised stays reconciled under the categories that
    #: did fire - never double-counted, never dropped.
    non_derivable: list[str] = field(default_factory=list)
    assessment: dict = field(default_factory=dict)
    consumed_available: bool = True
    observed_consumed_by_account: dict[str, int] = field(default_factory=dict)

    def add(self, category: str, cents: int) -> None:
        if category not in ALLOCATION_CATEGORIES:
            raise ValueError(f"unknown allocation category: {category}")
        self.by_category[category] = self.by_category.get(category, 0) + cents
        if self.total_unused_cents is not None:
            self.total_unused_cents += cents

    def to_dict(self) -> dict:
        return {
            "totalUnusedCents": self.total_unused_cents,
            "byCategory": dict(self.by_category),
            "consumedByAccount": dict(self.consumed_by_account),
            "nonDerivableCategories": list(self.non_derivable),
            "assessment": self.assessment,
            "consumedAvailable": self.consumed_available,
            "observedConsumedByAccount": self.observed_consumed_by_account,
        }


def _table_columns(
    con: duckdb.DuckDBPyConnection, table: str
) -> frozenset[str]:
    """The columns the table actually has, straight from DuckDB.

    Every other function in this module used to take a ``columns`` set from the
    caller and trust it. That is a contract the callers cannot be relied on to
    keep: :func:`allocate` never received one at all, so it named columns
    unconditionally and a file without them produced a Binder Error instead of
    an empty result. Reading the schema from the table removes the contract.
    """
    return frozenset(r[0] for r in con.execute(f"DESCRIBE {table}").fetchall())


def _col(columns: frozenset[str], name: str, absent: str = "''") -> str:
    """``name`` quoted, or a literal when the file does not have that column.

    DuckDB binds at plan time, so a missing column is a Binder Error rather than
    a NULL. Naming an optional column unconditionally turns a *degraded* report
    into a *missing* one: see the ``product/ProductFamily`` note in
    :func:`_reserved_instances`.
    """
    return f'"{name}"' if name in columns else absent


#: Which family each query keys on. Absent -> that family is not in the file.
SP_ID = "savingsPlan/SavingsPlanId"
RI_ID = "reservation/ReservationId"


def savings_plan_summaries(measurements: list[dict]) -> list[CommitmentSummary]:
    return [CommitmentSummary(
        id=m["plan_id"], type="savings-plan", service=m["service"],
        name="Savings Plan " + m["plan_id"],
        purchased_cents=m["metrics"]["purchased"]["value_cents"],
        used_cents=m["metrics"]["used"]["value_cents"], account=m["purchaser"] or "",
        measurement_json=m,
    ) for m in measurements]


def _savings_plans(con, window, *, table=TABLE, columns=None, where=None):
    measurements, _ = SP.analyse(con, window, table=table, where=where)
    return savings_plan_summaries(measurements)


def reserved_instance_summaries(measurements: list[dict]) -> list[CommitmentSummary]:
    return [CommitmentSummary(
        id=m["plan_id"], type="reserved-instance", service=m["service"],
        name="Reserved Instance " + m["plan_id"],
        purchased_cents=m["metrics"]["purchased"]["value_cents"],
        used_cents=m["metrics"]["used"]["value_cents"], account=m["purchaser"] or "",
        measurement_json=m,
    ) for m in measurements]


def _reserved_instances(con, window, *, table=TABLE, columns=None, where=None):
    from app.pipeline import reserved_instances
    measurements, _ = reserved_instances.analyse(con, window, table=table, where=where)
    return reserved_instance_summaries(measurements)


def summarise_commitments(
    con: duckdb.DuckDBPyConnection,
    window,
    *,
    columns: frozenset[str] | None = None,
    table: str = TABLE,
    where: str | None = None,
    sp_commitments: list[CommitmentSummary] | None = None,
    ri_commitments: list[CommitmentSummary] | None = None,
) -> list[CommitmentSummary]:
    """All commitments visible in the window.

    A file with no commitment columns yields an empty list, not an error: plenty
    of customers have none.

    The two families are read independently. They used to be read as one query
    with a retry that re-ran *only* the savings-plan half, so a file carrying
    reserved instances but no savings plans - which is what "RI-only" means -
    lost every reserved instance: the retry failed, the result was an empty
    list, and no unused-commitment finding was raised for money already spent.

    ``where`` scopes the rows to the checked files when a file-baseline check
    is running; a baseline file's plan rows inside the window dates are
    history, not this window's commitments.
    """
    where = resolve_role_scope(con, where, table=table)
    cols = columns if columns is not None else _table_columns(con, table)
    if SP_ID not in cols and RI_ID not in cols:
        return []

    summaries: list[CommitmentSummary] = []
    for family, ident in ((_savings_plans, SP_ID), (_reserved_instances, RI_ID)):
        if ident == SP_ID and sp_commitments is not None:
            summaries += sp_commitments
            continue
        if ident == RI_ID and ri_commitments is not None:
            summaries += ri_commitments
            continue
        if ident not in cols:
            continue
        try:
            summaries += family(con, window, table=table, columns=cols, where=where)
        except duckdb.Error as exc:
            # One family failing must not cost the other one. Say which, so the
            # log says what was lost rather than "partial".
            log.warning(
                "commitment family unavailable (%s): %s", ident, exc
            )
    return summaries


def allocate(
    con: duckdb.DuckDBPyConnection,
    commitments: list[CommitmentSummary],
    window,
    *,
    table: str = TABLE,
    where: str = "TRUE",
) -> AllocationSplit:
    """Split unused commitment money and attribute consumption by account.

    For a commitment shared across accounts, consumption is attributed to the
    account that actually used it (from the CUR rows themselves, not from an
    assumption). Where a plan shows usage we cannot attribute to any account,
    that money lands in ``unallocated`` rather than being quietly spread.
    """
    split = AllocationSplit()

    # Classification is not implemented for these categories. This is not a
    # claim that the file lacks term dates or contains no reservations.
    split.non_derivable = list(UNASSESSED_ALLOCATION_CATEGORIES)

    raw_categories: dict[str, Decimal] = {}
    raw_accounts: dict[str, Decimal] = {}
    for c in commitments:
        if c.measurement_json:
            m = c.measurement_json
            allocation = m["allocation"]
            if allocation["status"] != "available":
                split.consumed_available = False
            for account, value in allocation["exact_by_account"].items():
                raw_accounts[account] = raw_accounts.get(account, Decimal(0)) + Decimal(value)
            if c.unused_cents is None or not m["consistent"]:
                split.total_unused_cents = None
            elif Decimal(m["metrics"]["unused"]["exact"]) > 0:
                category = c.category()
                raw_categories[category] = raw_categories.get(category, Decimal(0)) + Decimal(m["metrics"]["unused"]["exact"])
        else:
            if c.unused_cents is None:
                split.total_unused_cents = None
            elif c.unused_cents > 0:
                split.add(c.category(), c.unused_cents)
    sp_total = SP.cents(sum(raw_categories.values(), Decimal(0)))
    for category, value in SP.apportion(raw_categories, sp_total).items():
        split.add(category, value)
    split.observed_consumed_by_account = {k: SP.cents(v) for k, v in raw_accounts.items()}
    if split.consumed_available:
        split.consumed_by_account = SP.apportion(raw_accounts, SP.cents(sum(raw_accounts.values(), Decimal(0))))
    split.assessment = {
        "status": "available" if split.total_unused_cents is not None and split.consumed_available
        else "partial" if commitments else "unavailable",
        "reasons": [reason for c in commitments if c.measurement_json
                    for reason in c.measurement_json["reasons"] + c.measurement_json["allocation"]["reasons"]],
    }
    return split


def detect_unused_commitment(
    tenant_id: str,
    con: duckdb.DuckDBPyConnection,
    window,
    *,
    columns: frozenset[str] | None = None,
    table: str = TABLE,
    sp_commitments: list[CommitmentSummary] | None = None,
    summaries: list[CommitmentSummary] | None = None,
    where: str | None = None,
) -> list[Finding]:
    """Flag commitments bought and not consumed (Task 4's waste check).

    A commitment is flagged when **both** waste conditions hold: utilisation
    is below :data:`WASTE_UTILISATION_TARGET` and the unused balance is at
    least :data:`UNUSED_MIN_CENTS`. The first keeps an almost-exhausted plan
    with a rounding remainder quiet; the second keeps a sub-dollar plan out
    of the findings.

    The stats block is the finding's auditable record: purchased, used,
    unused, utilisation, and **coverage** - the share of the eligible usage
    (same service and account, inside the window) that the commitment's
    benefit went against. Coverage is how "we bought too much" is told apart
    from "the usage was never eligible at all".
    """
    where = resolve_role_scope(con, where, table=table)
    commitments = summaries if summaries is not None else (
        summarise_commitments(con, window, columns=columns, table=table, where=where)
        if sp_commitments is None else sp_commitments + _reserved_instances(con, window, columns=columns, table=table, where=where)
    )
    findings: list[Finding] = []
    for c in commitments:
        unused = c.unused_cents
        if unused is None or c.utilization is None or (c.measurement_json and not c.measurement_json["consistent"]):
            continue
        if unused < UNUSED_MIN_CENTS:
            continue
        if c.utilization >= WASTE_UTILISATION_TARGET:
            # Mostly drawn on: the remainder is rounding, not waste.
            continue
        eligible = None if c.measurement_json else _eligible_usage_cents(
            con, c, window, columns=columns, table=table, where=where
        )
        coverage = (
            (Decimal(c.used_cents) / Decimal(eligible)).quantize(Decimal("0.0001"))
            if eligible
            else None
        )
        ratio = Decimal(1) - c.utilization
        f = Finding(
            # Account and region are part of the identity: a plan shared across
            # accounts produces one CommitmentSummary per account, and keying on
            # the plan id alone would give them all the same finding id - so at
            # persistence one account's usage would overwrite another's.
            id=make_finding_id(
                tenant_id,
                DetectorType.UNUSED_COMMITMENT,
                "|".join((c.id, c.type, c.account, c.region)),
                window.start,
                window.end,
            ),
            type=DetectorType.UNUSED_COMMITMENT,
            title=f"Unused {c.type.replace('-', ' ')}: {c.name}",
            description=(
                f"{unused} cents of a {c.purchased_cents} cent commitment were not consumed in "
                f"this window ({c.utilization * 100:.1f}% utilised). The cost is already sunk; "
                f"the question is whether the coverage can be redirected."
            ),
            severity=Severity.CRITICAL if ratio >= Decimal("0.75") else (
                Severity.HIGH if ratio >= Decimal("0.5") else Severity.MEDIUM
            ),
            service=c.service,
            account=c.account,
            region=c.region,
            resource=c.id,
            # ``coarse_key`` is deliberately left empty. This finding is measured
            # against a *commitment*, not against a usage grouping: the number is
            # the sunk cost of a plan that was not drawn on, and the rows that
            # source it are the commitment discount rows, not the usage line
            # items ``build_evidence`` queries. The coarse key here would be
            # (service, account, region, '', ''), and requiring usage_type and
            # operation to both be empty matches no real usage row - it would
            # return an evidence total of 0 next to a non-zero impact, which is
            # worse than declaring that there is no usage evidence to show.
            #
            # The evidence for this finding is the ``stats`` block below
            # (purchased / used / unused / utilisation), and the orchestrator
            # attaches an explicit caveat saying so. Do not "fix" this by
            # populating coarse_key.
            coarse_key=(),
            impact_cents=unused,
            normal_cents=c.purchased_cents,
            stats={
                "type": c.type,
                "measurement": c.measurement_json,
                "purchasedCents": c.purchased_cents,
                "usedCents": c.used_cents,
                "unusedCents": unused,
                "utilization": str(c.utilization),
                "utilisationTarget": str(WASTE_UTILISATION_TARGET),
                "eligibleUsageCents": eligible,
                "coverage": str(coverage) if coverage is not None else None,
                "coverageReason": "Gross amortized usage does not establish a comparable eligibility denominator." if c.measurement_json else None,
            },
        )
        findings.append(f)
    return findings


def _eligible_usage_cents(
    con: duckdb.DuckDBPyConnection,
    commitment: CommitmentSummary,
    window,
    *,
    columns: frozenset[str] | None,
    table: str = TABLE,
    where: str | None = None,
) -> int:
    """The window's usage cost this commitment could have covered.

    The services the commitment's own rows name, the same account, inside
    the window - and, for a reserved instance only, the same region, because
    an RI is region-scoped in a way a savings plan is not. (A savings plan's
    ``service`` field is its plan *type* - "Compute" - which is why the
    service set is read from the plan's rows rather than guessed from the
    type.) Returns 0 when the columns are missing, so coverage reports None
    rather than a lie.
    """
    where = resolve_role_scope(con, where, table=table)
    account_column = "lineItem/UsageAccountId"
    id_column = (
        "reservation/ReservationId"
        if commitment.type == "reserved-instance"
        else "savingsPlan/SavingsPlanId"
    )
    if columns is not None and (
        account_column not in columns or id_column not in columns
    ):
        return 0
    from app.pipeline.baseline import service_expr

    svc = service_expr(columns)
    account = commitment.account.replace("'", "''")
    plan_id = commitment.id.replace("'", "''")
    day = day_predicate(window.start, window.end)

    services = con.execute(
        f"SELECT DISTINCT {svc} FROM {table} "
        f"WHERE ({where}) AND {day} AND \"{account_column}\" = '{account}' "
        f"AND COALESCE(\"{id_column}\", '') = '{plan_id}'"
    ).fetchall()
    names = [text(r[0]) for r in services if text(r[0])]
    if not names:
        return 0
    in_list = ", ".join(f"'{n.replace(chr(39), chr(39) * 2)}'" for n in names)
    scope = f"{svc} IN ({in_list}) AND \"{account_column}\" = '{account}'"
    if commitment.type == "reserved-instance" and commitment.region:
        region_column = "product/Region"
        if columns is None or region_column in columns:
            scope += (
                f" AND COALESCE(\"{region_column}\", '') = "
                f"'{commitment.region.replace(chr(39), chr(39) * 2)}'"
            )
    total = con.execute(
        f"SELECT COALESCE(SUM(cost_cents), 0) FROM ("
        f"  SELECT {COST_CENTS_SQL} AS cost_cents FROM {table}"
        f"  WHERE ({where}) AND {day} AND ({scope})"
        f")"
    ).fetchone()[0]
    from app.pipeline.money import cents
    return cents(total or 0)
