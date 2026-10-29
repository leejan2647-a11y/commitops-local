# Unreleased — 2026-10-28

- Relicense the project under FSL-1.1-ALv2: source-available, no competing commercial use for two years per published version, converting irrevocably to Apache 2.0 after that. Releases published before 2026-10-29 remain MIT.
- Render dialogs outside filtered cards, keeping content scrollable and actions visible in short desktop/mobile windows. Preserve focus isolation, Escape and scroll restoration.
- Reuse hash-verified retained bytes across local upload records; retain primary/comparison identities and label manual-check versus direct-Library origins. Protect files used by saved checks.
- Show shared check history in Library. New reports reference immutable checks with SHA256 verification and frozen review notes instead of copying full results. Existing reports remain readable without migration.
- Separate test-only follow-up: clean up the annotation fixture so it cannot become another test's latest check. Financial assertions are unchanged.

# 0.5.5

Publish the local app as npm package commitops with command commitops. Keep existing local data and runtime directories for continuity. Display CommitOps throughout the workspace.

# 0.5.4

Use loopback port 43187 by default; retain --port for conflicts. Update documentation navigation and rewrite the user guide for new users.

# 0.5.3

Reuse exact encoded field fragments within bounded batches; reduce scalar identity lookups. Read history checks and labels once per page and batch resource aliases. Preserve financial results and per-request artifact verification.

# 0.5.2

Reduce redundant canonical partition setup for small byte-bounded inputs. Same-file SQL calls fell from 1151 to 207; stable financial results matched exactly. Large-input partitioning and multi-core budgets remain unchanged.

# 0.5.1

Fix Teams response contract; complete canonical history aliases and finding links, invalidate stale mappings; add customer documentation and 20% creep controls; make structured printable HTML the default report download. Financial detector, source-format and ledger controls passed. Bounded load probes stopped by safeguards; performance capacity remains unverified.

# 0.5.0

Replace the simplified UI with the main React manual workspace. Add local API projections, canonical Teams History, printable reports and local cancellation. Remove hosted navigation and automatic integrations.

# 0.4.2

- Refresh local sessions securely from the origin-checked page, repairing uploads and team saves after restart.
- Move upload/run controls to Check Charges; external check buttons open that page and its file picker. Dashboard shows summaries.
- Remove the device resources panel and bulk mapping text area; keep structured team add/edit/delete controls.

# 0.4.1

- Restore the selected device baseline when switching comparison modes. Respect the saved supported date-range preference and keep empty metric placeholders as `-`. Focused DOM regression passed.

# 0.4.0 - Your Local Cost Explorer

- Rename the public project and npm command to `your-local-cost-explorer`. Keep the existing private data/runtime directory so upgrading does not lose saved work.
- Keep the local light design and sidebar. Remove Data Sources navigation; upload and retained-file controls appear only on Dashboard. Replace broken dash characters with `-`.
- Inspect observed CUR dates locally for CSV, gzip and Parquet. Offer supported 7/30/90/180-day windows ending at the supplied data's latest date, with earlier rows as baseline. Missing history stays unavailable.
- Put previous-check and device-file comparisons below the baseline fields. Retained comparisons verify original file hashes and cannot contaminate primary data.
- Preserve all eight detectors, exact decimal financial calculations, commitments, allocation, settings and downloadable local reports. No hosted or automatic connections are included.

Focused verification: real loopback uploads, CUR date aliases/formats/conflicts, calendar windows, previous-check provenance and separation, DOM upload/period/button behavior, small independent signed-charge/rounding ledger, duplicate removal, original eight-detector and commitment controls, hosted pricing withdrawal tests, frontend typecheck and production build. No large-file laptop stress test.
