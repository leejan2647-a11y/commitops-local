# CommitOps

**Find the line item that moved your AWS bill.**

CommitOps reads your AWS Cost and Usage Report on your own machine and shows the
evidence behind each finding.

`npx commitops` · CUR 1.0 and 2.0 · CSV, gzip, Parquet · loopback only

[![npm](https://img.shields.io/npm/v/commitops?style=flat-square&logo=npm&color=f76b70)](https://www.npmjs.com/package/commitops)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#requirements)
[![License](https://img.shields.io/badge/license-FSL--1.1--ALv2-4b5563?style=flat-square)](LICENSE)

---

> [!IMPORTANT]
> **This repository closes on 28 November 2026.**
> The automated edition launches that day as a paid edition. Connect a read-only
> AWS role once, and checks will run on a schedule.
> Existing installs keep working offline.
> **[Launch details →](https://commitops.cc.cd)**

---

## Contents

[The problem](#the-problem) · [What you get](#what-you-get) · [Quick start](#quick-start) · [The eight detectors](#the-eight-detectors) · [Inside the app](#inside-the-app) · [Privacy](#privacy-by-architecture) · [Limits](#limits-worth-knowing) · [28 November](#what-happens-on-28-november-2026) · [Requirements](#requirements)

## The problem

Cost Explorer tells you which service got more expensive. It does not show the
billing rows behind the change, or which account and commitment an unused amount
belongs to.

The Cost and Usage Report has the rows behind those answers. It also carries your
account IDs, resource IDs and every billed line item. Uploading that to someone
else's server is a hard sell.

CommitOps reads the export on your machine and puts the rows on screen.

Built for the platform or finance engineer who gets asked "why is the bill up?"
and has an afternoon to answer it.

```text
$ npx commitops
Open http://127.0.0.1:43187/#token=…
Local files only. Press Ctrl+C to stop. Keep the launch URL private.
```

## What you get

- **Evidence with every finding.** Each finding shows its scope, dates and
  measurement basis. Usage-based amounts include the billing rows behind them and
  any unexplained remainder.
- **See what you paid for and did not use.** Reserved Instance and Savings Plan
  amounts, split into purchased, consumed and unused, per account and per
  commitment. The unused amount stays with the account and commitment that
  produced it.
- **See who owns the spend.** Map AWS account IDs to teams in Settings. Then read
  the consumption the file can attribute, by account and by team.
- **A spending ledger you can audit.** Teams History builds one ledger from
  retained exports, removes proven duplicates, and keeps each check's totals
  separate.
- **Baselines from your own dates.** The 7, 30, 60, 90 and 180-day windows, the
  full range and manual dates all use your file's dates. A compatible earlier
  export can serve as the comparison.
- **Reports you can hand over.** Save a named report that references the original
  checks, then download it as a printable HTML document. You can also export a
  check's findings as CSV.

## Quick start

Requires **Node.js 20 or newer**. On first run, the launcher installs a pinned
Python runtime and the Python packages the analysis needs. Those downloads need
network access. Analysis afterwards runs entirely offline.

The local edition is free to install and run.

```bash
npx commitops
```

Or install it once:

```bash
npm install -g commitops
commitops
```

Open the URL the launcher prints. It carries a per-launch token, so keep it
private. Choose **Check Charges** and drop in a CUR export (CSV, `.csv.gz` or
Parquet; CUR 1.0 and 2.0 both work). Confirm the dates your file covers, then
start the check.

No export yet? Download the example CUR in **Check Charges**, or read AWS's
[CUR guide](https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html).

<details>
<summary>Run from source instead</summary>

```bash
git clone https://github.com/leejan2647-a11y/commitops-local.git
cd commitops-local
npm install
npm start
```

The built frontend is included. To change the UI:

```bash
npm --prefix frontend install
npm run build:ui
```

Tests: `npm test` covers the managed runtime; the Python suite runs separately.
</details>

## The eight detectors

| Detector | What it asks |
|---|---|
| **Unexpected charge** | Is spending sustained above a comparable baseline? |
| **Spike** | Was there an unusually expensive day? |
| **Gradual creep** | Is daily cost trending up consistently, not just once? |
| **New charge** | Did a group start spending meaningfully where there was little before? |
| **Usage-cost mismatch** | Did cost and usage move in different directions? |
| **Marketplace** | Which Marketplace charges deserve a look? |
| **Expectation mismatch** | Does observed spend match the expectation you supplied? |
| **Unused commitment** | Is a Savings Plan or Reserved Instance going unconsumed? |

Each detector needs particular columns and enough history. **An unavailable
assessment means the file could not answer the question. It does not mean the
spending is fine.**

The creep threshold in Settings sets the minimum sustained growth for the
gradual-creep detector. Lower values increase sensitivity; higher values require
stronger growth. It looks at the trailing eight weeks of daily charges and scales
your monthly threshold to that period using a 30-day month. The rise must be
meaningful, consistent and still climbing near the end. A short export or a
single step change can produce no finding.

## Inside the app

| Page | What it does |
|---|---|
| **Dashboard** | Saved-check summaries, spending history and recent findings |
| **Check Charges** | Upload CUR files, confirm dates, add comparison exports, run or cancel a check |
| **Findings** | Filter, search, open the evidence, add notes and review states, archive |
| **Commitments** | Savings Plan and Reserved Instance utilisation, with unused amounts |
| **Allocation** | Which accounts consume shared Savings Plan and Reserved Instance commitments |
| **Teams History** | Ledger across retained checks, with drilldowns by team, account, service, resource and IAM identity |
| **Reports** | Saved reports as printable HTML, with CSV exports of check findings |
| **Library** | Retained files and check history; identical content is reused, and in-use files cannot be deleted |
| **Settings** | Company name, default date range, creep threshold, team mappings |
| **Documentation** | The user guide, inside the app |

## Privacy by architecture

- The service listens on **loopback only** (`127.0.0.1`), so other machines on
  your network cannot reach it.
- API requests require a **per-launch token** and a same-origin check.
- Analysis runs in a child process with **outbound connections blocked** and
  DuckDB automatic extension loading disabled.
- Files, results, SQLite state, team mappings and reports stay on the device.
- There is no analytics or telemetry service.
- You supply the export file. Nothing is fetched from your AWS account.

## Limits worth knowing

**This edition works from the file you hand it.** You download the CUR, start
each check, and download each report. Those three manual steps are what the
automated edition removes.

The evidence limits apply to every edition, including the automated one.

- **A finding is a lead.** Open the evidence and judge it.
- **Do not add findings together.** Detectors measure different things over
  different periods and can overlap. A sum matches no invoice and no savings
  figure.
- **An upload is not an invoice.** Rows alone cannot prove complete export
  delivery or final invoice reconciliation.
- **Missing data stays missing.** Absent fields and dates show as unavailable,
  never as zero.
- **Your machine sets the limit here.** This edition has no commercial file-size
  or batch limits. What completes depends on your CPU, RAM and free disk.

## What happens on 28 November 2026

The repository closes. The automated edition launches the same day.

| Then | What it means for you |
|---|---|
| **This repository** | Stops receiving changes. Treat the current commit as the final one. |
| **Your install** | Keeps running offline. The version you installed does not expire. |
| **The local edition** | Stays free and stops being maintained here. |
| **The automated edition** | Paid. It will use a read-only AWS connection, run checks on a schedule, and deliver reports when they finish. |

**Why close it:** maintaining a manual edition and an automatic one in parallel
duplicates work and slows the release cadence. A single edition is faster to
maintain, and automation is where the product is going.

**Follow the launch:** [commitops.cc.cd](https://commitops.cc.cd).

## Requirements

| | |
|---|---|
| Node.js | 20 or newer |
| OS | 64-bit Windows, macOS, Linux |
| CPU | Two cores is a practical starting point for small exports |
| Memory | 8 GB is a practical starting point for small exports, not a guarantee |
| Disk | Several GB free for small exports, plus room for your source files |
| Network | Needed for install and first-run dependency setup; not for analysis |

## Documentation

The user guide ships inside the app. Open **Documentation** from the footer for the
first check, date selection, the eight detectors, reports and recovery.

## Contributing

This repository closes on 28 November 2026, so large pull requests are not a good
use of your time. A **CUR edge case** is genuinely useful: a format, column layout
or date pattern that produced a wrong or unavailable result. I will read it before
the repository closes.

Please do not paste real billing exports into an issue. Column names and the error
message are enough.

## License

[FSL-1.1-ALv2](LICENSE) © 2026 CommitOps.

**Source-available, not open source.** You may read, run, modify and redistribute
this code for any purpose except one: building a competing commercial product or
service out of it. That restriction lasts **two years from the date each version
is published**, after which that version converts permanently to
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).

Running CommitOps on your own AWS bill, or inside the company you work for, is a
permitted purpose. So are teaching with it and non-commercial research.

Earlier npm releases, including 0.5.5, were published under MIT and remain
available under those terms.

The Functional Source License is maintained at [fsl.software](https://fsl.software/).

---

<sub>This repository contains the local edition of CommitOps. It is not affiliated with Amazon Web Services.
"CUR", "Cost Explorer", "Savings Plans" and "Reserved Instances" are AWS terms used descriptively.</sub>
