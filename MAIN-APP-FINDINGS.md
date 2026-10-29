# Main application findings - recorded only

2026-10-28. Main application source was not modified during the local React migration.

## Date preset uses N+1 inclusive days

`commitops-web/src/lib/window-choice.ts`, `datesFromAnchor`, computes windowStart as anchor minus N days and includes both endpoints. A 30-day preset therefore selects 31 calendar days. Its dialog explicitly labels this behavior. This differs from the latest local-edition request for the last N days. Local copy now selects exactly N inclusive days; hosted behavior is recorded for owner review without changes.

## Performance candidate: sequential canonical encoding and many short SQL operations

A small local check using the shared pipeline recorded 1151 main-connection SQL calls. Canonical scalar encoding uses a sequential Python loop with 512-row fetch batches. Normal four-thread mode took 10.43s versus 9.36s with one DuckDB thread in one diagnostic pair. This is a candidate for investigation, not a proven main-app regression or a recommendation to disable parallelism. Main app unchanged. See docs/local-verification-20261028/NORMAL-RESOURCE-USE.md.

## Canonical partition overhead resolved after owner authorization

2026-10-28: a small-input, byte-bounded partition choice reduced the same-file trace from 1151 to 207 SQL calls with identical stable results. Applied to local and main sources following explicit authorization. Larger inputs retain the old partition path. See docs/local-optimization-20261028/REPORT.md.
