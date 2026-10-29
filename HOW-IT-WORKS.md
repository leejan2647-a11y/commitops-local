# User guide

## Run your first check

Start the app and open the local address shown in your terminal. Choose Check Charges and upload an AWS Cost and Usage Report in CSV, compressed CSV (.csv.gz), or Parquet format. The app reads the dates in your files so you can select the period to review. Confirm the dates, optionally add earlier comparison data, and start the check. When it finishes, review the coverage warnings as well as the findings. Files and results are stored on your device.

## Choose analysis and comparison data

Primary files supply the charges for the period you are reviewing. Earlier observations establish a baseline for detectors that compare spending over time. You can use history within your primary exports or explicitly select comparison files from your device or Library. Comparison rows do not become additional primary spending. Choose compatible billing scopes and check that the dates cover the periods you intend to compare. Missing days or columns can limit which conclusions are available.

## Understand the eight cost detectors

Unexpected charge identifies sustained spending above a comparable baseline. Spike identifies unusually expensive days. Gradual creep identifies a continuing upward trend in daily costs. New charge identifies meaningful spending in a group with little earlier spend. Usage-cost mismatch identifies cases where cost and usage changes diverge. Marketplace highlights AWS Marketplace charges for review. Expectation mismatch compares supported service expectations with observed charges when expectations have been supplied. Unused commitment identifies source-supported unused Savings Plan or Reserved Instance commitments. Each detector requires particular fields and sufficient evidence; an unavailable assessment does not mean that no problem exists.

## Choose a creep detection threshold

The creep monthly growth threshold sets the minimum sustained growth needed for a gradual-creep finding. Enter a positive percentage in Settings. Lower values increase sensitivity; higher values require stronger growth. This setting affects only gradual creep. The detector examines the trailing eight weeks of daily charges and scales the monthly threshold to that period using a 30-day month. It also checks that the rise is meaningful, the trend is sufficiently consistent and costs continue rising near the end. A short export or a single step change may therefore produce no finding. This is a detector sensitivity setting, not a spending cap or forecast. New settings apply to new checks; saved checks retain their original results.

## Read findings and financial amounts

A finding is a lead for investigation, not proof that a charge is wrong. Open it to inspect its scope, dates, measurement basis, evidence and caveats. Different detectors measure different things: a daily change, a period excess or an unused commitment may use different time bases. Their amounts can overlap, so do not add finding amounts together to calculate a bill or guaranteed savings. Use review states, notes and labels to track your investigation. These annotations do not change the saved financial calculation.

## Review commitments and allocation

Commitments shows Savings Plan and Reserved Instance observations supported by the supplied billing records. Purchased, used and unused amounts can be unavailable when required evidence is missing. Allocation explains supported attribution to accounts and teams. In Settings, map an AWS account ID to a team name to make those accounts easier to recognize. A mapping changes the displayed attribution, not the underlying charges. Review measurement periods and coverage before interpreting utilization or unused amounts.

## Explore Teams History

Teams History builds a spending ledger from retained primary exports associated with selected completed checks. Use its date filters and drilldowns to explore teams, accounts, services, resources and supplied IAM identities. Proven duplicate observations are removed, including overlaps between checks; check totals are not simply added together. Resource names are shown only when supplied in the source. Keep original files available for rebuilding history. Missing, modified or conflicting evidence can prevent a trustworthy result. Rebuild when the app marks history stale after a mapping change.

## Use the dashboard and monthly insights

The dashboard summarizes saved analysis results; use Check Charges to start a new analysis. Reported AWS charges describe the signed charges present in the selected source rows. Monthly insights distinguish spending changes from estimates of comparable daily cloud usage when complete, compatible evidence is available. Current-month observations are month to date, not a forecast. Cloud spending or usage changes do not establish company, revenue or profit growth. Read the dated periods, comparison sources and exclusions before interpreting a percentage.

## Save and share a report

Library is the central catalogue of retained files and check history. It labels files selected for manual checks and files added directly to Library. Re-uploading identical content reuses verified retained bytes while keeping primary and comparison roles separate. Files used by saved checks cannot be deleted through Library. Other pages read the same saved checks rather than saving another history copy.

New named reports refer to the original immutable checks and keep their own review notes. Their integrity is checked when opened. Existing reports remain supported in their original format; they are not automatically rewritten.

In Reports, select completed checks and save a named report. Download report creates a structured HTML document with the review scope, reported charges, findings, commitments and source identities. Open the file in a browser to read or print it; your browser can also save it as a PDF. Share the downloaded file yourself when needed. The app does not send email, call webhooks or create public report links. Reports may contain sensitive billing information, so share them only with intended recipients.

## Install and start the app

Install Node.js 20 or later on a supported 64-bit Windows, macOS or Linux system. Run npm install -g commitops, then run commitops in a terminal and open the local address it prints. You can also clone the public repository, run npm install and then npm start. Initial setup downloads a managed Python runtime and pinned analysis dependencies, so internet access is needed for installation. You do not need to configure Python, Docker, PostgreSQL, Redis or a hosted account separately. Use a current desktop browser. Dependency availability may vary by operating system and processor architecture.

## Plan memory and disk use

There is no commercial file-size or batch-count limit. Processing requirements depend on row width, grouping complexity, duplicates and compression, not file size alone. For small-file use, 8 GB RAM, two CPU cores and several GB of free working disk are a practical starting recommendation, not a guaranteed minimum for every export. Start with a smaller export when trying a new device. The app uses available CPU resources, bounds its analysis-engine memory allowance and can use temporary disk storage. Some stages run sequentially. If resources are insufficient, free memory or disk space, choose a larger working drive or use a more capable device before retrying.

## Recover from an unsuccessful check

Read the error and coverage guidance before retrying. For format errors, use an original supported AWS CUR export and check its required columns. For date problems, select dates represented in the files and provide compatible earlier data if a comparison is needed. For source conflicts, select one authoritative export delivery rather than combining conflicting revisions. For resource failures, free memory or working disk. Cancel an active check when necessary; cancelled or failed work must not be treated as a completed financial result. Keep previously saved evidence available for review.

## Keep local data private

Analysis runs on your device. The service listens on the loopback address and uses a per-launch token and origin checks to protect API requests. It has no AWS connection, automatic schedules, hosted sign-in, payment processing or external delivery. Analysis-worker outbound connections and automatic database-extension downloads are disabled. Installation still contacts public dependency registries. Protect your device account, retained exports, local database and downloaded reports. Back up data you need to keep; removing retained exports can prevent later history rebuilding.

## Understand evidence limits

Uploaded billing rows do not independently establish complete export delivery or final invoice reconciliation. The app removes proven identical copies and refuses conflicting observations instead of guessing. Missing fields and dates remain unknown rather than being converted into zero. Monetary calculations use decimal arithmetic and the app’s cent-rounding rules. Results describe the supplied evidence and selected scope; verify coverage and relevant AWS billing records before making financial or operational decisions.
