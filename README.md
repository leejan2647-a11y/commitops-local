# CommitOps

**Find the line item that moved your AWS bill.**

CommitOps reads your AWS Cost and Usage Report on your own machine and shows the
billing rows behind every finding.

`npx commitops` · CUR 1.0 and 2.0 · CSV, gzip, Parquet · loopback only

[![npm](https://img.shields.io/npm/v/commitops?style=flat-square&logo=npm&color=f76b70)](https://www.npmjs.com/package/commitops)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4b5563?style=flat-square)](#requirements)
[![License](https://img.shields.io/badge/license-FSL--1.1--ALv2-4b5563?style=flat-square)](LICENSE)

---

> [!IMPORTANT]
> **This repository closes on 28 November 2026.**
> The edition that replaces it runs the same analysis on a schedule. Connect a
> read-only AWS role once, and checks run without you.
> **[Follow the launch →](https://commitops.cc.cd)**
> Installs you already have keep working offline.

---

## Contents

[The problem](#the-problem) · [What you get](#what-you-get) · [Quick start](#quick-start) · [The eight detectors](#the-eight-detectors) · [Inside the app](#inside-the-app) · [Privacy](#privacy-by-architecture) · [Limits](#what-this-edition-does-not-do) · [28 November](#what-happens-on-28-november-2026) · [Requirements](#requirements)

## The problem

Cost Explorer tells you which service got more expensive. It does not tell you
which line item moved, whether the change is real usage, or whether a commitment
you already paid for is going unused.

The file that answers those questions is the Cost and Usage Report. It also
carries your account IDs, your resource IDs and a detailed picture of how you use
AWS. Uploading that to someone else's server is a hard sell.

CommitOps reads the file where it already sits and puts the rows on screen.

Built for the platform or finance engineer who gets asked "why is the bill up?"
and has an afternoon to answer it.

```text
$ npx commitops
  CommitOps 0.5.5
  ready → http://127.0.0.1:43187
```

## What you get

- **Evidence with every finding.** Each finding carries the billing rows that
  produced it, plus an explicit *unexplained remainder* when those rows do not
  add up to the finding amount.
- **Commitment accountability.** Reserved Instance and Savings Plan purchased,
  consumed and unused, per account and per commitment, with the unused amount
  attributed instead of averaged away.
- **Team ownership.** Map AWS account IDs to teams in Settings and read supported
  consumption by account, team and service.
- **A spending ledger you can rebuild.** Teams History assembles one ledger from
  your retained exports, removes proven duplicates and keeps check totals
  separate.
- **Baselines anchored to your data.** 7, 30, 90 or 180-day windows use the dates
  in your own files, and any earlier export can serve as the comparison.
- **Reports you can hand over.** Whole-check JSON, a printable HTML report, CSV,
  or an immutable snapshot kept in the Library.

## Quick start

Requires **Node.js 20 or newer**. The launcher installs a pinned Python runtime
and the analysis dependencies on first run.

```bash
npx commitops
```

Or install it once:

```bash
npm install -g commitops
commitops
```

Open **http://127.0.0.1:43187**, choose **Check Charges**, drop in a CUR export
(CSV, `.csv.gz` or Parquet; CUR 1.0 and 2.0 both work), confirm the dates your
file covers, and start the check.

The first launch needs network access for those downloads. Analysis afterwards
runs entirely offline.

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

Tests: `npm test` for the launcher and runtime, plus the managed Python suite
under `tests/`.
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

The creep threshold in Settings controls one detector's sensitivity. It scales
your monthly threshold across the trailing eight weeks and requires the rise to
be consistent and still climbing at the end. A short export or a single step
change can correctly produce no finding.

## Inside the app

| Page | What it does |
|---|---|
| **Dashboard** | Summaries of saved checks, monthly spending and usage observations |
| **Check Charges** | Upload CUR files, confirm dates, add comparison exports, run or cancel a check |
| **Findings** | Filter, search, open the evidence, add notes and review states, archive |
| **Commitments** | Savings Plan and Reserved Instance utilisation, with unused amounts |
| **Allocation** | Consumption by category, account and team |
| **Teams History** | Ledger across retained checks, with drilldowns by team, account, service and resource |
| **Reports** | Saved reports as JSON, printable HTML, CSV or print |
| **Library** | Retained files and check history, with SHA-256 verification on open |
| **Settings** | Company name, default date range, creep sensitivity, team mappings |
| **Documentation** | The user guide, inside the app |

## Privacy by architecture

- The service listens on **loopback only** (`127.0.0.1`), so nothing on your
  network can reach it.
- Every API request carries a **per-launch token** and same-origin checks.
- Analysis runs in a child process with **outbound connections blocked** and
  DuckDB automatic extension loading disabled.
- Files, results, SQLite state, team mappings and reports stay on the device.
- You supply the export file. Nothing is fetched from your AWS account.

## What this edition does not do

**This edition works from the file you hand it.** You download the CUR yourself,
start each check yourself, and download each report yourself. Those three manual
steps are exactly what the next edition removes.

**Never claimed, in any edition:**

- **A finding is a lead, not proof.** CommitOps shows evidence and lets you
  judge it.
- **Finding amounts are not additive.** Detectors measure different things over
  different periods and can overlap, so a sum of findings matches no invoice and
  no savings figure.
- **An upload is not an invoice.** Rows alone cannot establish complete export
  delivery or final invoice reconciliation.
- **Missing data stays missing.** Absent fields and dates are reported as
  unavailable rather than converted to zero.
- **No capacity claim.** There are no commercial file-size or batch limits; what
  completes depends on your CPU, RAM and free disk.

## What happens on 28 November 2026

The repository closes and the automated edition launches.

| Then | What it means for you |
|---|---|
| **This repository** | Stops receiving changes. It is not coming back. |
| **Your install** | Keeps running offline. No server dependency, no expiry. |
| **The local edition** | Stays free. It simply stops being maintained and distributed here. |
| **The new edition** | Same analysis, automated: a read-only AWS connection, checks on a schedule, and reports delivered when they finish. |

**Why close it:** maintaining a manual edition and an automatic one in parallel
means every fix lands twice and ships twice as slowly. One edition moves faster,
and the automatic one is the point of the tool.

**To follow the launch:** [commitops.cc.cd](https://commitops.cc.cd) or star this
repository before it closes.

## Requirements

| | |
|---|---|
| Node.js | 20 or newer |
| OS | 64-bit Windows, macOS, Linux |
| Disk | Working space for your exports and temporary analysis files |
| Memory | 8 GB is a practical starting point for small exports, not a guarantee |
| Network | Needed for install and first-run dependency setup; not for analysis |

## Documentation

- [User guide](HOW-IT-WORKS.md) for the first check, dates, detectors, reports and recovery
- [Manual feature map](MANUAL-FEATURES.md) for exactly what the local edition includes
- [Local architecture](DESIGN.md) for how the local adapters differ from the hosted build
- [Changelog](CHANGELOG.md)

## Contributing

This repository closes in 30 days, so large pull requests are not a good use of
your time. A **CUR edge case** is genuinely useful: a format, column layout or
date pattern that produced a wrong or unavailable result. I will read it before
the repository closes.

Please do not paste real billing exports into an issue.

## License

[FSL-1.1-ALv2](LICENSE) © 2026 CommitOps.

**Source-available, not open source.** You may read, run, modify and redistribute
this code for any purpose except one: building a competing commercial product or
service out of it. That restriction lasts **two years from the date each version
is published**, after which that version converts permanently to
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).

Running CommitOps on your own AWS bill, or inside the company you work for, is a
permitted purpose. So are teaching with it and non-commercial research.

Releases published before 29 October 2026 were licensed under MIT and remain
available under those terms.

The Functional Source License is maintained at [fsl.software](https://fsl.software/).

---

<sub>CommitOps is a local analysis tool. It is not affiliated with Amazon Web Services.
"CUR", "Cost Explorer", "Savings Plans" and "Reserved Instances" are AWS terms used descriptively.</sub>
