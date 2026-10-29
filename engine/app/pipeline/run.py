"""The orchestrator - run steps 1 to 6 in order and attach evidence to the result.

Until this module existed the pipeline was six correct functions that nothing
called together. ``build_evidence`` in particular was only ever reached from a
test, so in a real run every finding came back with ``evidence = None`` and
``unexplained_remainder = 0`` - the product's central promise, "evidence or
nothing", implemented and tested but never actually delivered.

This module is the single entry point that makes it real. It owns three
responsibilities and deliberately nothing else:

1. **Order.** ingest -> validate -> baseline -> detect -> evidence -> commitments.
   The order is not arbitrary. Evidence must be gathered at the grain the
   finding was measured at, and the detectors only record that grain on the
   finding itself, so evidence cannot run before detection.
2. **The evidence allowance.** Deciding how much of each billing row counts as
   "normal" so the rest counts as contribution. See :func:`_allowance_cents`.
3. **Honesty about what cannot be shown.** Findings that were not measured
   against a usage grouping get an explicit caveat rather than a fabricated
   evidence card.

Deliberately still free of auth, HTTP, and database concerns, exactly like the
rest of ``app.pipeline``. That is what keeps it runnable from a Celery worker,
a CLI, and a test without a container, and it is why persistence is a separate
step that consumes :class:`CheckResult` rather than something this module does.

The one thing that must never regress: ``expectations`` is forwarded to the
detectors. It is an optional argument, so dropping it is silent, and the only
visible symptom is that ``expectation-mismatch`` quietly stops firing - a
cleaner-looking result for a check that got less thorough. See
``_forward_expectations``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Final

import duckdb

from app.core.resources import analysis_connection
from app.pipeline import baseline as _baseline
from app.pipeline import commitments as _commitments
from app.pipeline import comparison as _comparison
from app.pipeline import currency as _currency
from app.pipeline import detectors as _detectors
from app.pipeline import evidence as _evidence
from app.pipeline import finding_amounts as _amounts
from app.pipeline import ingest as _ingest
from app.pipeline import reserved_instances as _ri
from app.pipeline import savings_plans as _sp
from app.pipeline import spend_history as _spend_history
from app.pipeline import validate as _validate
from app.growth.contracts import GrowthCapture, GrowthSource
from app.pipeline.creep_policy import DEFAULT_MONTHLY_PERCENT, monthly_percent
from app.pipeline.ingest import ROLE_BASELINE
from app.pipeline.money import (
    MoneyInputError,
    cents,
    precise,
    validate_costs,
    validate_reported_costs,
)
from app.pipeline.types import (
    CoarseBaselineRow,
    DataWindow,
    DetectorType,
    Finding,
    ServiceExpectation,
)

log = logging.getLogger(__name__)

#: Why a finding carries no usage-row evidence. Keyed by detector so the reason
#: is specific rather than a generic shrug - a customer reading the caveat should
#: be told *what* would have to change for the evidence to exist.
_NO_USAGE_EVIDENCE: dict[DetectorType, str] = {
    DetectorType.UNUSED_COMMITMENT: (
        "no usage-line-item evidence is shown for this finding: the amount is the "
        "sunk cost of a commitment that was not drawn on, and the rows that source "
        "it are the commitment discount rows rather than usage line items. See the "
        "purchased / used / unused / utilisation figures on the commitment itself."
    ),
}


class CheckFailed(Exception):
    """The source could not be analysed at all.

    Distinct from a validation problem, and deliberately so. Validation never
    blocks a check: a customer whose file is three cents off the manifest still
    needs to know what is wrong with their bill, so problems there become
    fields on the report plus a caveat and the check proceeds.

    An unreadable file or missing required CUR 1.0/CUR 2.0 columns leaves no
    honest result to return, so this propagates. The boundary - the RQ task
    or the API route - catches it and reports a *failed* check. A readable,
    correctly shaped export with no billing rows is handled separately.
    """

    def __init__(self, message, *, diagnostics=None):
        super().__init__(message)
        self.diagnostics = diagnostics

    def validation_report(self):
        report = {"caveats": [f"check failed: {self}"]}
        if self.diagnostics:
            d = self.diagnostics
            canonical = d.get("canonicalization", d if "rawRows" in d else {})
            canonical = canonical if isinstance(canonical, dict) else {}
            report.update(
                assessmentStatus="refused",
                canonicalization=canonical,
                failure={
                    k: d[k]
                    for k in (
                        "code",
                        "message",
                        "recovery",
                        "differingFields",
                        "conflictRows",
                        "conflictGroups",
                        "invalidRows",
                        "invalidOutputs",
                        "column",
                    )
                    if k in d
                },
                totalRows=canonical.get("rawRows"),
                uniqueRows=canonical.get("canonicalRows"),
                duplicateRows=canonical.get("removedCopyRows"),
                computedTotalCents=None,
                windowTotalCents=None,
                reconciliationStatus="unavailable",
            )
        return report


@dataclass
class CheckResult:
    """Everything one check produced.

    Returned whole so the caller can persist it, render it, or assert on it
    without re-running the pipeline. ``findings`` is a list because the
    findings themselves are mutable - evidence is attached to them in place.
    """

    findings: list[Finding] = field(default_factory=list)
    validation: _validate.ValidationReport | None = None
    currency_proof: dict = field(default_factory=dict)
    commitments: list[_commitments.CommitmentSummary] = field(default_factory=list)
    allocation: _commitments.AllocationSplit | None = None
    window: DataWindow | None = None
    caveats: list[str] = field(default_factory=list)
    #: The source identifier exactly as passed to :func:`run_check` (a local
    #: path or an s3/r2/https URI). Persisted as a hash on the checks row so a
    #: re-run of the same source is recognisable without keeping the path.
    source: str = ""
    sp_assessment: dict = field(default_factory=dict)
    ri_assessment: dict = field(default_factory=dict)
    #: Per-coarse-group daily p95 the detectors compared against, sorted for
    #: determinism. Persisted to the ``baselines`` table by step 7 so a
    #: finding's "normal" stays answerable after this process is gone.
    baselines: list[CoarseBaselineRow] = field(default_factory=list)
    monthly_growth: GrowthCapture | None = None

    @property
    def explained_cents(self) -> int:
        """Impact the billing rows actually account for."""
        return sum(
            int(f.evidence.evidence_total * 100) for f in self.findings if f.evidence is not None
        )

    @property
    def unexplained_cents(self) -> int:
        """Impact that no row accounts for. The honest answer, not a defect."""
        return sum(int(f.unexplained_remainder * 100) for f in self.findings)


def _allowance_cents(
    finding: Finding,
    baseline_numbers: dict[_baseline.GroupKey, _comparison.PeriodStats],
) -> int:
    """The daily baseline for this finding's grouping.

    This is the subtlety that decides whether the evidence card means anything.
    ``build_evidence`` applies ``max(daily_net_cost - allowance, 0)`` once
    per day, then allocates excess to contributing rows in integer cents.

    ``Finding.normal_cents`` is not one. It is whatever the producing detector
    happened to mean by "normal": the daily p95 for ``unexpected-charge`` and
    ``spike``, but ``cost_per_day_before * check_days`` - a whole-window total -
    for ``usage-cost-mismatch``. Passing it straight through subtracts 31 days of
    baseline from a single day of cost, every row clamps to zero, and the finding
    ends up with an evidence total of 0 sitting next to a non-zero impact. That
    is worse than no evidence card at all, and it is the same unit mismatch that
    once made the detectors compare a 31-day total against a daily p95 and
    flag every steady service in the account.

    So the allowance is taken from the group's own comparison numbers
    (:mod:`app.pipeline.comparison` - the same zero-filled daily totals the
    detectors compared against) instead, which is daily by construction and
    uniform across detectors:

    - a group with sufficient history contributes ``p95_cents`` - its own daily
      p95, so a $50 day against a $10 baseline contributes $40, the increase;
    - a group with too little history contributes 0, because for a genuinely new
      charge the whole row *is* new and subtracting an invented normal would
      understate it.

    Returned in cents because that is what ``build_evidence`` expects.
    """
    if not finding.coarse_key:
        return 0
    key = _baseline.GroupKey.from_coarse(finding.coarse_key)
    stats = baseline_numbers.get(key)
    if stats is None or not stats.sufficient:
        return 0
    return max(stats.p95_cents, 0)


def _attach_evidence(
    con: duckdb.DuckDBPyConnection,
    findings: list[Finding],
    window: DataWindow,
    baseline_numbers: dict[_baseline.GroupKey, _comparison.PeriodStats],
    columns: frozenset[str] | None,
    *,
    primary_where: str = "TRUE",
) -> None:
    """Give every finding its evidence, in place.

    Two rules, both learned the hard way:

    - **Gather at the finding's own grain.** ``Finding.coarse_key`` is recorded
      by the detector that produced the finding, and is used verbatim. It is not
      re-derived from ``service``/``account``/``region``/``usage_type`` because
      ``Finding`` does not carry ``operation`` or ``lineItemType``, so the
      measurement grain is not reconstructible from the other fields - and
      evidence gathered at a different grain selects the wrong rows.
    - **Skip honestly when there is nothing to show.** A finding with no
      ``coarse_key`` was not measured against a usage grouping. It gets a caveat
      naming the reason, not an empty evidence card.

    ``primary_where`` scopes the row selection to the checked files' rows when
    a file-baseline check is running: a baseline file may legitimately contain
    rows *inside* the check window (the spec's overlap case), and evidence is
    money, so "which half of the table a row came from" is a filter, not a
    detail.
    """
    for finding in findings:
        if not finding.coarse_key:
            reason = _NO_USAGE_EVIDENCE.get(
                finding.type,
                "no usage-line-item evidence is available for this finding; it was not "
                "measured against a billing grouping",
            )
            finding.caveats.append(reason)
            log.info("finding %s (%s) has no usage evidence to gather", finding.id, finding.type)
            continue

        key = _baseline.GroupKey.from_coarse(finding.coarse_key)
        bstats = baseline_numbers.get(key)
        impact_scope = None
        evidence_start, evidence_end = window.start, window.end
        # Bind each spike's evidence to its own persisted run population.
        if bstats and bstats.sufficient and bstats.p95_cents >= 0:
            if finding.type == DetectorType.UNEXPECTED_CHARGE:
                impact_scope = {"kind": finding.type.value}
            elif finding.type == DetectorType.SPIKE:
                impact_scope = {
                    "kind": finding.type.value,
                    "runFirstDay": finding.stats.get("runFirstDay"),
                    "runDays": finding.stats.get("runDays"),
                }
                try:
                    first = date.fromisoformat(impact_scope["runFirstDay"])
                    days = impact_scope["runDays"]
                    if (
                        type(days) is int
                        and days > 0
                        and window.start <= first <= first + timedelta(days=days - 1) <= window.end
                    ):
                        evidence_start, evidence_end = first, first + timedelta(days=days - 1)
                        impact_scope["selectedRun"] = True
                except (ValueError, TypeError):
                    pass
        finding.evidence = _evidence.build_evidence(
            con,
            key=key,
            start=evidence_start,
            end=evidence_end,
            impact_cents=finding.impact_cents,
            allowance_cents=0 if finding.type == DetectorType.MARKETPLACE
            else _allowance_cents(finding, baseline_numbers),
            impact_scope=impact_scope,
            source_filter=_detectors.marketplace_evidence_filter(columns or frozenset(), finding.stats)
            if finding.type == DetectorType.MARKETPLACE else None,
            columns=columns,
            fields=_comparison.COMPARISON_FIELDS,
            primary_where=primary_where,
        )


#: When the baseline's own daily-total p95 is at least this many times its
#: median, the baseline period itself contains enough abnormal days to raise
#: the "normal" the detectors compare against. That is a property of
#: percentile-based detection (AWS Cost Anomaly Detection behaves the same
#: way), and the honest response is to say so on the result rather than to
#: change the algorithm: a customer whose history is mostly abnormal should
#: read smaller window spikes with care.
_P95_INFLATION_RATIO: Final[int] = 5


def _baseline_inflation_caveat(
    con: duckdb.DuckDBPyConnection, window: DataWindow, where: str
) -> str | None:
    """The honest warning when the baseline itself is abnormal.

    Tenant-wide daily totals over the baseline; when the p95 sits at
    :data:`_P95_INFLATION_RATIO` times the median, more than ~5% of the
    baseline days are unusually high, and those days set the upper limits the
    detectors compare against. A smaller real spike in the window can then
    sit under the inflated limit and go unreported - which is exactly the
    thing the customer should know before trusting a "no findings" result.

    Deliberately coarse (one tenant-wide series, not per group): the caveat's
    job is to warn, not to re-implement the detectors.
    """
    rows = con.execute(
        f'SELECT CAST("lineItem/UsageStartDate" AS DATE) AS day, '
        f"       SUM({_ingest.COST_CENTS_SQL}) AS cents "
        f"FROM {_ingest.TABLE} "
        f"WHERE ({where}) AND {_ingest.day_predicate(window.baseline_start, window.baseline_end)} "
        f"GROUP BY day ORDER BY day"
    ).fetchall()
    values = [r[1] or 0 for r in rows]
    if len(values) < _baseline.MIN_HISTORY_DAYS:
        return None  # the thin-history caveat already covers this case
    values.sort()
    median = values[len(values) // 2]
    p95 = values[min(len(values) - 1, int(len(values) * 0.95))]
    if median <= 0 or p95 < median * _P95_INFLATION_RATIO:
        return None
    return (
        f"The baseline period itself contains unusually high days (its daily "
        f"total p95 is {cents(p95)} cents against a median of {cents(median)} cents). Those days "
        f"raise the normal-level estimate, so smaller new spikes in the window can "
        f"stay under it and go unreported. If part of the baseline was abnormal, "
        f"narrow the baseline dates to the normal period and run the check again."
    )


def _forward_expectations(
    expectations: Sequence[ServiceExpectation],
) -> list[ServiceExpectation]:
    """Pass the operator's stated expectations through to the detectors.

    This function is one line of real work wrapped in a defensive check, and
    that is the point. ``expectations`` is an optional argument, so the natural
    way to write the call below is to simply not mention it - and the result is
    not an error, it is a *cleaner looking* result. ``expectation-mismatch`` is
    the only detector that reads it, so a dropped argument silently narrows the
    check to seven detectors and nothing anywhere says so.

    Normalising to a list here means an empty tuple, an empty list, and ``None``
    are all handled once, and the count is logged so the log line for every
    check records how many expectations were actually evaluated. A run that
    quietly evaluated none is visible in the logs even when the caller made a
    mistake in a different layer.
    """
    forwarded = []
    for expectation in expectations or ():
        amount, unparsed = _detectors.parse_expected_amount(expectation.note)
        if expectation.stated_amount_cents is None:
            expectation = replace(expectation, stated_amount_cents=amount, unparsed=unparsed)
        elif _detectors.unsupported_expectation_period(expectation.note):
            expectation = replace(expectation, stated_amount_cents=None, unparsed=True)
        forwarded.append(expectation)
    if not forwarded:
        log.info("check evaluated with no stated expectations; expectation-mismatch is inactive")
    else:
        unparsed = sum(1 for e in forwarded if e.unparsed)
        log.info(
            "check evaluating %d stated expectation(s) (%d with no parseable figure)",
            len(forwarded),
            unparsed,
        )
    return forwarded


@precise
def run_check(
    sources: str | Sequence[str],
    window: DataWindow,
    tenant_id: str,
    *,
    baseline_sources: Sequence[str] | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
    declared_total: object = None,
    expectations: Sequence[ServiceExpectation] | None = None,
    as_of: date | None = None,
    progress: Callable[[str], None] | None = None,
    creep_monthly_growth_percent: object = None,
    growth_sources: Sequence[GrowthSource] | None = None,
    growth_as_of: datetime | None = None,
) -> CheckResult:
    """Run the full analysis over one or more data sources, for one window.

    :param sources: a single local ``.csv``/``.csv.gz``/``.parquet`` path or
        ``s3://``/``r2://``/``https://`` URI, or a list of them (an S3 sync's
        downloaded files). Lists are sorted before anything touches DuckDB, so
        the same inputs always produce the same findings ids. A mixed list of
        parquet and CSV files is read per-source and unioned BY NAME.
    :param window: the period to analyse, plus the prior period used as the
        baseline. The two must not overlap; :class:`DataWindow` enforces that.
    :param tenant_id: namespaces the finding ids, so two tenants analysing the
        same window cannot collide.
    :param baseline_sources: optional history FILES the caller chose
        explicitly (the custom-baseline feature). When given, every row is
        stamped with a source role; the baseline statistics read these files'
        rows and every window-scoped reader sees only the checked files'
        rows. Without it nothing changes: no role column exists and the
        in-file history is the baseline, exactly as before.

        Three edge cases are handled here rather than deeper down, because
        they are policy rather than mechanics: a baseline *file* whose dates
        overlap the check *window* is separated by its role, not by its
        dates, so the check still runs and a caveat says so; baseline files
        with no billing rows make comparisons unavailable, with recovery
        guidance, while independent primary Savings Plan analysis remains
        available; and a missing or non-CUR baseline file refuses the whole
        check. A selected empty baseline never falls back to in-file history.
    :param con: an existing DuckDB connection to reuse. A fresh in-memory one is
        created and closed when omitted.
    :param declared_total: the total the CUR manifest claims, if the source has
        one. Left as ``None`` for file uploads, which have no manifest - that
        yields ``reconciliation_status = "unavailable"`` rather than a fabricated
        pass.
    :param expectations: what the operator said they expected, per service. See
        :func:`_forward_expectations` for why this is not optional in practice.
    :param as_of: the date freshness is measured against. Defaults to the end of
        the window so a re-run of the same window is reproducible; a live check
        should pass today's date.
    :param progress: optional callback invoked with each phase name as it
        starts - ``ingest``, ``validate``, ``baseline``, ``detect``,
        ``evidence``, ``commitments``. Step 8's RQ task uses it to publish
        job-meta progress; the pipeline itself treats it as pure observation
        and never lets a callback failure break a check.

    :raises CheckFailed: a source could not be read or lacks required CUR columns.
        For a multi-file check, the error names the offending file. See
        that exception for why this is the only failure that stops a check.
    """
    from pathlib import Path
    for local_source in ([sources] if isinstance(sources, str) else list(sources)) + list(baseline_sources or ()):
        text = str(local_source)
        if "://" in text or text.startswith(("\\\\", "//")) or not Path(text).is_file():
            raise CheckFailed("Only existing local files are supported")

    def _report(phase: str) -> None:
        if progress is not None:
            try:
                progress(phase)
            except Exception:  # noqa: BLE001 - observation must never break the check
                log.exception("progress callback failed for phase %s; continuing", phase)

    primary = [str(sources)] if isinstance(sources, str) else sorted(str(s) for s in sources)
    try:
        creep_sensitivity = monthly_percent(DEFAULT_MONTHLY_PERCENT if creep_monthly_growth_percent is None else creep_monthly_growth_percent)
    except ValueError as exc:
        raise CheckFailed(str(exc)) from exc
    baseline = sorted(str(s) for s in (baseline_sources or ()))
    label = ",".join(primary)

    owned = con is None
    con = con or analysis_connection()
    try:
        result = CheckResult(window=window, source=label)
        forwarded = _forward_expectations(expectations or ())

        # --- Step 1: ingest -------------------------------------------------
        _report("ingest")
        if not baseline and len(primary) == 1:
            # The single-file path, exactly as it always was: no role column,
            # no union. Every pre-Feature-3 caller lands here.
            loaded = _ingest.ingest(primary[0], con=con)
        else:
            loaded = _ingest.ingest_many(primary, baseline_sources=baseline or None, con=con)
        if loaded.error:
            if loaded.missing_required == {"lineItem/CurrencyCode"}:
                error = _currency.CurrencyInputError()
                error.diagnostics["canonicalization"] = loaded.diagnostics
                raise CheckFailed(str(error), diagnostics=error.diagnostics)
            if loaded.diagnostics:
                raise CheckFailed(loaded.error, diagnostics=loaded.diagnostics)
            raise CheckFailed(f"could not read {loaded.source}: {loaded.error}")

        try:
            validate_costs(con)
        except MoneyInputError as exc:
            exc.diagnostics["canonicalization"] = loaded.diagnostics
            raise CheckFailed(str(exc), diagnostics=exc.diagnostics) from exc

        if loaded.row_count == 0:
            # Valid, and worth saying out loud: an empty but correctly shaped
            # export means "no charges in this window", not "broken file".
            result.caveats.append(
                "the source contains no billing rows, so there is nothing to analyse"
            )

        # --- Roles: which reads see which half of the table ------------------
        # `primary_where` scopes every window-scoped reader to the checked
        # files' rows. It answers TRUE on the single-file table (no role
        # column), which is what keeps the legacy path identical rather than
        # merely equivalent - the predicates below are appended
        # unconditionally.
        primary_where = _ingest.role_filter(con)
        # Empty selected history disables comparisons rather than silently
        # substituting in-file history. Independent primary commitment reads
        # retain their own evidence requirements below.
        baseline_unavailable = False
        use_file_baseline = loaded.role_column and loaded.baseline_rows > 0
        if loaded.role_column and loaded.baseline_rows == 0:
            baseline_unavailable = True
            result.caveats.append(
                "The selected baseline contains no history; comparisons are unavailable. Supply earlier history. Primary Savings Plan analysis remains independent."
            )
        baseline_where = (
            _ingest.role_filter(con, role=ROLE_BASELINE) if use_file_baseline else "TRUE"
        )

        # Task 6: when baseline files are supplied, the baseline is THOSE
        # FILES' history, not a date-sliced part of it. The comparison period
        # is the files' own date range, so a history file that predates the
        # requested baseline dates is still the baseline instead of yielding
        # "0 days of comparison data". The end is clamped to the day before
        # the window: a file reaching into the window keeps those rows out
        # of the baseline (the overlap caveat below says what was noticed).
        if use_file_baseline:
            b_min, b_max = con.execute(
                f'SELECT min(CAST("lineItem/UsageStartDate" AS DATE)), '
                f'max(CAST("lineItem/UsageStartDate" AS DATE)) '
                f"FROM {_ingest.TABLE} WHERE {baseline_where}"
            ).fetchone()
            derived_end = (
                min(b_max, window.start - timedelta(days=1))
                if b_max
                else window.start - timedelta(days=1)
            )
            if b_min is None or derived_end < b_min:
                baseline_unavailable = True
                result.caveats.append(
                    "The selected baseline has no earlier history; comparisons are unavailable. Supply earlier history. Primary Savings Plan analysis remains independent."
                )
            else:
                window = DataWindow(
                    start=window.start,
                    end=window.end,
                    baseline_start=b_min,
                    baseline_end=derived_end,
                )
                result.window = window
                result.caveats.append(
                    f"the baseline comes from the selected file(s), covering "
                    f"{b_min.isoformat()} to "
                    f"{derived_end.isoformat()}"
                    + (
                        f" (the files reach to {b_max.isoformat()}; only the part "
                        "before the window contributes)"
                        if b_max != derived_end
                        else ""
                    )
                )

        # The overlap edge case is a *file* whose dates reach into the check
        # window. Role separation keeps those rows out of every window read,
        # so the check still runs - but the customer chose files that overlap
        # and a caveat is how they learn the analysis noticed.
        if use_file_baseline:
            overlapping = int(
                con.execute(
                    f"SELECT count(*) FROM {_ingest.TABLE} "
                    f"WHERE {_ingest.role_filter(con, role=ROLE_BASELINE)} "
                    f"AND {_ingest.day_predicate(window.start, window.end)}"
                ).fetchone()[0]
            )
            if overlapping:
                result.caveats.append(
                    f"{overlapping} row(s) in the selected baseline files fall "
                    "inside the check window; they are excluded from the "
                    "window's analysis by their source role. Only earlier baseline dates "
                    "contribute to the comparison"
                )

        # --- Step 2: validate -----------------------------------------------
        # Never blocks the check. Problems become fields on the report plus a
        # caveat; the customer still needs to be told what is wrong with the
        # file even if the analysis is imperfect. The computed total reads only
        # the checked files' rows when roles exist - a baseline month's spend
        # is history, not this window's bill.
        window_where = f"({primary_where}) AND {_ingest.day_predicate(window.start, window.end)}"
        history_where = f"({baseline_where}) AND {_ingest.day_predicate(window.baseline_start, window.baseline_end)}"
        applicable_currency = _currency.validate(con, f"({window_where}) OR ({history_where})")
        result.currency_proof = {
            **_currency.validate(con, window_where),
            "version": "check_currency_v1",
            "period": _amounts.period(window.start, window.end),
        }
        _report("validate")
        result.validation = _validate.validate(
            con,
            loaded.columns,
            as_of=as_of or window.end,
            declared_total=declared_total,
            primary_where=primary_where,
        )
        result.caveats.extend(result.validation.caveats)
        if _currency.unsupported_count(con, primary_where):
            result.currency_proof["whole_file"] = {"status": "unavailable", "currency": None}
            # Out-of-scope currencies do not invalidate the requested USD
            # analysis, but a whole-file sum cannot combine them.
            result.validation.computed_total_cents = None
            result.validation.variance_cents = None
            result.validation.reconciliation_status = "unavailable"
            result.caveats.append(
                "The source contains unsupported currencies outside the selected analysis scope; its whole-file monetary total is unavailable."
            )
        else:
            result.currency_proof["whole_file"] = _currency.validate(con, primary_where)

        window_where = f"({primary_where}) AND {_ingest.day_predicate(window.start, window.end)}"
        history_where = (
            f"({baseline_where}) AND "
            f"{_ingest.day_predicate(window.baseline_start, window.baseline_end)}"
        )
        result.validation.window_total_cents = _ingest.cost_sum_cents(con, window_where)
        result.validation.window_rows = con.execute(
            f"SELECT count(*) FROM {_ingest.TABLE} WHERE {window_where}"
        ).fetchone()[0]
        result.validation.baseline_rows = con.execute(
            f"SELECT count(*) FROM {_ingest.TABLE} WHERE {history_where}"
        ).fetchone()[0]
        history_days = con.execute(
            f'SELECT count(DISTINCT CAST("lineItem/UsageStartDate" AS DATE)) '
            f"FROM {_ingest.TABLE} WHERE {history_where}"
        ).fetchone()[0]
        result.validation.assessment_status = "limited" if result.caveats else "complete"
        if result.validation.window_rows == 0:
            result.validation.window_total_cents = None
            result.validation.assessment_status = "no_data"
            result.caveats.append(
                "No billing rows fall inside the selected dates. Choose dates covered "
                "by the export; this check cannot assess whether charges are normal."
            )
        elif history_days < _baseline.MIN_HISTORY_DAYS:
            result.validation.assessment_status = "limited"
            result.caveats.append(
                f"Only {history_days} days of comparison data are available. "
                f"At least {_baseline.MIN_HISTORY_DAYS} are needed for reliable historical comparisons."
            )
        observed_start, observed_end = con.execute(
            f'SELECT min(CAST("lineItem/UsageStartDate" AS DATE)), '
            f'max(CAST("lineItem/UsageStartDate" AS DATE)) '
            f"FROM {_ingest.TABLE} WHERE {primary_where}"
        ).fetchone()
        if result.validation.window_rows and (
            observed_start > window.start or observed_end < window.end
        ):
            result.validation.assessment_status = "limited"
            result.caveats.append(
                f"The checked export covers {observed_start} to {observed_end}, "
                "only part of the requested window. Missing dates cannot be assumed to have zero spend."
            )

        result.validation.spend_history = _spend_history.capture(
            con, window, primary_where=primary_where, baseline_where=baseline_where,
            source_formats=loaded.source_formats, file_baseline=use_file_baseline,
            baseline_unavailable=baseline_unavailable,
            reconciliation_status=result.validation.reconciliation_status,
        )

        # SP analysis uses canonical primary observations, before comparison
        # refusals, and the exact same result feeds findings and storage.
        measurements, result.sp_assessment = _sp.analyse(con, window, where=primary_where)
        sp_commitments = _commitments.savings_plan_summaries(measurements)
        ri_measurements, result.ri_assessment = _ri.analyse(con, window, where=primary_where)
        ri_commitments = _commitments.reserved_instance_summaries(ri_measurements)
        result.commitments = _commitments.summarise_commitments(
            con,
            window,
            columns=loaded.columns,
            where=primary_where,
            sp_commitments=sp_commitments,
            ri_commitments=ri_commitments,
        )
        result.allocation = _commitments.allocate(
            con, result.commitments, window, where=primary_where
        )
        result.allocation.assessment["savingsPlans"] = result.sp_assessment
        result.allocation.assessment["reservedInstances"] = result.ri_assessment
        population_reasons = [r for r in result.sp_assessment["reasons"] + result.ri_assessment["reasons"]
                              if r["code"] in {"sp_identifier_missing", "sp_inventory_unknown",
                                               "ri_identifier_missing", "ri_inventory_unknown"}]
        if population_reasons:
            result.allocation.total_unused_cents = None
            result.allocation.consumed_available = False
        if result.allocation.total_unused_cents is None:
            result.allocation.by_category = {}
        if not result.allocation.consumed_available:
            result.allocation.consumed_by_account = {}
        result.allocation.assessment["reasons"] = _sp.compact_reasons(
            result.allocation.assessment["reasons"] + population_reasons
        )
        result.allocation.assessment["status"] = (
            "available" if result.allocation.total_unused_cents is not None and result.allocation.consumed_available
            else "partial" if result.commitments else "unavailable"
        )
        result.allocation.assessment["population"] = "selected_primary_files"
        result.allocation.assessment["allFamiliesIdentified"] = not bool(population_reasons)
        for reason in result.sp_assessment["reasons"] + result.ri_assessment["reasons"]:
            note = reason["message"] + " " + reason["recovery"]
            if note not in result.caveats:
                result.caveats.append(note)
        result.findings = _commitments.detect_unused_commitment(
            tenant_id,
            con,
            window,
            columns=loaded.columns,
            sp_commitments=sp_commitments,
            summaries=result.commitments,
        )
        for finding in result.findings:
            finding.caveats.append(_NO_USAGE_EVIDENCE[DetectorType.UNUSED_COMMITMENT])
        if baseline_unavailable:
            result.validation.assessment_status = "limited"
            validate_reported_costs(result)
            return _amounts.finalize(result, applicable_currency)

        # --- Step 3: baseline -----------------------------------------------
        # The comparison contract runs first (Task 2): both sides of every
        # charge-jump comparison are computed by ONE module -
        # app.pipeline.comparison - one grouping key, one cost column, one
        # zero-fill rule. The guard refuses periods that were not measured to
        # that contract, and marks short periods low-confidence; both are
        # visible in the result payload, never silently absorbed.
        _report("baseline")
        baseline_numbers = _comparison.period_stats(
            con,
            start=window.baseline_start,
            end=window.baseline_end,
            columns=loaded.columns,
            table=_ingest.TABLE,
            where=baseline_where,
        )
        window_numbers = _comparison.period_stats(
            con,
            start=window.start,
            end=window.end,
            columns=loaded.columns,
            table=_ingest.TABLE,
            where=primary_where,
        )
        guard = _comparison.comparison_guard(window, file_baseline=use_file_baseline)
        for reason in guard.confidence:
            result.caveats.append(reason)
            if result.validation.assessment_status == "complete":
                result.validation.assessment_status = "limited"
        # The p95-dilution warning (2026-10-10): a baseline that is itself
        # mostly abnormal raises the limits the detectors compare against,
        # and a "no findings" result read off such a history is stronger than
        # the data supports. Warned, not silently absorbed - and the
        # detection algorithm is untouched.
        inflation = _baseline_inflation_caveat(con, window, baseline_where)
        if inflation is not None:
            result.caveats.append(inflation)
            if result.validation.assessment_status == "complete":
                result.validation.assessment_status = "limited"
        if guard.refusals:
            # Nothing can be compared, so nothing is emitted - not a partial
            # result, not a traceback. The recorded reason is the check's
            # visible payload, and the refused check still persists.
            for reason in guard.refusals:
                result.caveats.append(reason)
            result.validation.assessment_status = "refused"
            log.warning(
                "check refused: the comparison contract was violated: %s",
                "; ".join(guard.refusals),
            )
            validate_reported_costs(result)
            return _amounts.finalize(result, applicable_currency)

        base = _baseline.build_baseline(
            con,
            window,
            columns=loaded.columns,
            baseline_where=baseline_where,
            primary_where=primary_where,
        )

        # Carried on the result for step 7: the per-group daily p95 is the one
        # honest "normal" that survives the process, because Finding.normal_
        # cents means different things to different detectors. Sorted so two
        # runs of the same window persist byte-identical rows. The p95 here
        # is the comparison grain's upper limit: the 95th percentile of the
        # group's zero-filled baseline daily totals.
        result.baselines = [
            CoarseBaselineRow(key.coarse, cents(stats.p95_cents))
            for key, stats in sorted(baseline_numbers.items(), key=lambda kv: kv[0].as_tuple())
        ]

        # Totals at the comparison grain, because that is the grain run_all's
        # detectors compare at. Handing it BASELINE_FIELDS here is the exact
        # mistake that left the detectors structurally blind to EC2.
        totals = _baseline.check_window_totals(
            con,
            window,
            columns=loaded.columns,
            fields=_comparison.COMPARISON_FIELDS,
            where=primary_where,
        )

        # --- Step 4: detect -------------------------------------------------
        # `table` is deliberately not passed: run_all resolves None to the
        # default itself, and passing an explicit None once built "FROM None".
        _report("detect")
        result.findings = _detectors.run_all(
            tenant_id,
            con,
            base,
            window,
            totals=totals,
            baseline_numbers=baseline_numbers,
            window_numbers=window_numbers,
            expectations=forwarded,  # never drop this: see _forward_expectations
            columns=loaded.columns,
            baseline_where=baseline_where,
            primary_where=primary_where,
            sp_commitments=sp_commitments,
            commitment_summaries=result.commitments,
            creep_monthly_growth_percent=creep_sensitivity,
        )
        if not result.validation.baseline_rows:
            # Missing history is not evidence that an existing service is new.
            result.findings = [f for f in result.findings if f.type != DetectorType.NEW_CHARGE]

        # --- Step 5: evidence ----------------------------------------------
        # In place, after detection, because the grain evidence must be gathered
        # at is only known once a detector has recorded it on its finding.
        _report("evidence")
        _attach_evidence(
            con,
            result.findings,
            window,
            baseline_numbers,
            loaded.columns,
            primary_where=primary_where,
        )

        _report("commitments")

        from app.pipeline.routing_tags import capture as capture_routing_tags
        try:
            capture_routing_tags(con, result.findings, window, loaded.columns, primary_where)
        except duckdb.Error:
            # Optional nonfinancial enrichment must not discard measurements
            # already computed. Never retain partially captured tag ownership.
            for finding in result.findings:
                finding.routing_tags = {}
            result.caveats.append(
                "Exported tag ownership is unavailable for this check because its metadata query failed. "
                "Retry the check or use an account/service/team owner mapping. Financial measurements are unchanged."
            )
            log.warning("tag ownership metadata query failed; financial results retained")

        log.info(
            "check complete: %d finding(s), %d cents explained, %d cents unexplained, "
            "%d commitment(s), %d caveat(s)",
            len(result.findings),
            result.explained_cents,
            result.unexplained_cents,
            len(result.commitments),
            len(result.caveats),
        )
        if growth_sources is not None:
            from app.pipeline.monthly_growth import capture_months
            result.monthly_growth = capture_months(
                con, sources=growth_sources, primary_where=primary_where,
                baseline_where=baseline_where, as_of=growth_as_of or datetime.now(timezone.utc),
            )
        validate_reported_costs(result)
        return _amounts.finalize(result, applicable_currency)

    except MoneyInputError as exc:
        exc.diagnostics["canonicalization"] = loaded.diagnostics
        raise CheckFailed(str(exc), diagnostics=exc.diagnostics) from exc
    finally:
        if owned:
            con.close()
