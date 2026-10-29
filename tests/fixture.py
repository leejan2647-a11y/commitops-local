from __future__ import annotations
import csv,random,uuid
from datetime import date,timedelta
from decimal import Decimal
from pathlib import Path

BASELINE_START = date(2024, 4, 1)

BASELINE_END = date(2024, 8, 24)

CHECK_START = date(2024, 8, 25)

CHECK_END = date(2024, 9, 24)

ACCOUNTS = ("111111111111", "222222222222")

REGIONS = ("us-east-1", "us-west-2")

CUR_COLUMNS = [
    "identity/LineItemId",
    "lineItem/UsageStartDate",
    "lineItem/UsageEndDate",
    "lineItem/UsageAccountId",
    "lineItem/LineItemType",
    "lineItem/UsageType",
    "lineItem/Operation",
    "lineItem/ResourceId",
    "lineItem/AvailabilityZone",
    "lineItem/UsageAmount",
    "lineItem/NormalizedUsageAmount",
    "lineItem/UnblendedCost",
    "lineItem/CurrencyCode",
    "product/Region",
    "product/ProductName",
    "product/ProductFamily",
    "product/InstanceType",
    "savingsPlan/SavingsPlanId",
    "savingsPlan/SavingsPlanType",
    "savingsPlan/PaymentOption",
    "savingsPlan/TotalCommitmentToDate",
    "savingsPlan/UsedCommitment",
    "reservation/ReservationId",
    "reservation/TotalReservedUnits",
    "reservation/UsedReservationUnits",
    "marketplace/ProviderName",
    "marketplace/ProductName",
    "bill/BillingPeriodStartDate",
    "bill/BillingPeriodEndDate",
    "bill/BillType",
]

SPIKE_SERVICE = "AmazonEC2"

SPIKE_MULTIPLIER = Decimal("5")

SPIKE_DAYS = 3

CREEP_SERVICE = "AmazonRDS"

CREEP_DAILY_INCREMENT = Decimal("0.10")

NEW_SERVICE = "AmazonElastiCache"

NEW_SERVICE_DAILY = Decimal("80")

NEW_SERVICE_DAYS = 5

MISMATCH_SERVICE = "AmazonCloudFront"

MISMATCH_MULTIPLIER = Decimal("4")

MARKETPLACE_PROVIDER = "Datadog"

MARKETPLACE_DAILY = Decimal("60")

MARKETPLACE_DAYS = 4

SP_PURCHASED = Decimal("500")

SP_USED = Decimal("200")

def _d(value: Decimal) -> str:
    """Render a Decimal as a CUR cost string (CUR stores costs as text)."""
    return f"{value:.2f}"

def _row(
    *,
    row_id: str,
    day: date,
    account: str,
    region: str,
    service: str,
    usage_type: str,
    operation: str,
    cost: Decimal,
    usage: Decimal,
    resource_id: str = "",
    provider: str = "",
    marketplace_product: str = "",
) -> dict[str, str]:
    return {
        "identity/LineItemId": row_id,
        "lineItem/UsageStartDate": day.isoformat(),
        "lineItem/UsageEndDate": (day + timedelta(days=1)).isoformat(),
        "lineItem/UsageAccountId": account,
        "lineItem/LineItemType": "Usage",
        "lineItem/UsageType": usage_type,
        "lineItem/Operation": operation,
        "lineItem/ResourceId": resource_id,
        "lineItem/AvailabilityZone": f"{region}a",
        "lineItem/UsageAmount": str(usage),
        "lineItem/NormalizedUsageAmount": str(usage),
        "lineItem/UnblendedCost": _d(cost),
        "lineItem/CurrencyCode": "USD",
        "product/Region": region,
        "product/ProductName": service,
        "product/ProductFamily": "Compute" if service == SPIKE_SERVICE else "Database",
        "product/InstanceType": "m5.xlarge" if service == SPIKE_SERVICE else "",
        "savingsPlan/SavingsPlanId": "",
        "savingsPlan/SavingsPlanType": "",
        "savingsPlan/PaymentOption": "",
        "savingsPlan/TotalCommitmentToDate": "",
        "savingsPlan/UsedCommitment": "",
        "reservation/ReservationId": "",
        "reservation/TotalReservedUnits": "",
        "reservation/UsedReservationUnits": "",
        "marketplace/ProviderName": provider,
        "marketplace/ProductName": marketplace_product,
        "bill/BillingPeriodStartDate": f"{day.year}-{day.month:02d}-01",
        "bill/BillingPeriodEndDate": f"{day.year}-{day.month:02d}-01",
        "bill/BillType": "Invoice",
    }

def build_cur_rows(*, with_duplicates: int = 0, seed: int = 7) -> list[dict[str, str]]:
    """Build the full synthetic CUR export.

    Anomalies, all inside the check window:

    * ``AmazonEC2`` spikes to 5x for the last 3 days (spike + unexpected charge)
    * ``AmazonRDS`` creeps +$0.10/day for the whole check window (gradual creep)
    * ``AmazonElastiCache`` appears only in the check window (new charge)
    * ``AmazonCloudFront`` cost quadruples while usage stays flat (usage/cost mismatch)
    * a Marketplace vendor charges appear only in the check window (marketplace)
    * legacy Savings Plan-shaped fields on Usage rows (insufficient native fee inventory)
    """
    rng = random.Random(seed)
    rows: list[dict[str, str]] = []
    n = 0

    def nid() -> str:
        nonlocal n
        n += 1
        return f"li-{n:08d}"

    all_days = [BASELINE_START + timedelta(days=i) for i in range((CHECK_END - BASELINE_START).days + 1)]

    for day in all_days:
        in_check = day >= CHECK_START
        days_into_check = (day - CHECK_START).days

        for account in ACCOUNTS:
            for region in REGIONS:
                # --- steady baseline services -------------------------------
                for service, daily, usage_type, op in (
                    ("AmazonS3", Decimal("1.00"), "TimedStorage-ByteHrs", "StandardStorage"),
                    ("AWSDataTransfer", Decimal("0.50"), "DataTransfer-Out-Bytes", "DataTransfer-Out"),
                ):
                    jitter = Decimal(str(round(rng.uniform(-0.05, 0.05), 2)))
                    cost = max(daily + jitter, Decimal("0"))
                    rows.append(
                        _row(
                            row_id=nid(), day=day, account=account, region=region, service=service,
                            usage_type=usage_type, operation=op, cost=cost,
                            usage=Decimal(rng.randint(100, 200)),
                        )
                    )

                # --- EC2: steady, then a 5x spike at the tail ---------------
                ec2_cost = Decimal("10.00")
                ec2_usage = Decimal("24")
                if in_check and days_into_check >= (CHECK_END - CHECK_START).days - (SPIKE_DAYS - 1):
                    ec2_cost *= SPIKE_MULTIPLIER
                    ec2_usage *= SPIKE_MULTIPLIER
                rows.append(
                    _row(
                        row_id=nid(), day=day, account=account, region=region, service=SPIKE_SERVICE,
                        usage_type="BoxUsage:m5.xlarge", operation="RunInstances", cost=ec2_cost,
                        usage=ec2_usage, resource_id=f"i-{rng.randrange(10**9, 10**10)}",
                    )
                )

                # --- RDS: steady, then a slow +$0.10/day creep --------------
                rds_cost = Decimal("2.00") + (CREEP_DAILY_INCREMENT * days_into_check if in_check else Decimal(0))
                rows.append(
                    _row(
                        row_id=nid(), day=day, account=account, region=region, service=CREEP_SERVICE,
                        usage_type="InstanceUsage:db.r6g.xlarge", operation="RunInstances",
                        cost=rds_cost, usage=Decimal("24"),
                    )
                )

                # --- ElastiCache: brand new, check window only --------------
                if in_check and days_into_check < NEW_SERVICE_DAYS:
                    rows.append(
                        _row(
                            row_id=nid(), day=day, account=account, region=region, service=NEW_SERVICE,
                            usage_type="NodeUsage:cache.t4g.micro", operation="CreateCacheCluster",
                            cost=NEW_SERVICE_DAILY, usage=Decimal("744"),
                        )
                    )

                # --- CloudFront: cost x4, usage flat -------------------------
                cf_cost = Decimal("3.00")
                if in_check:
                    cf_cost *= MISMATCH_MULTIPLIER
                rows.append(
                    _row(
                        row_id=nid(), day=day, account=account, region=region, service=MISMATCH_SERVICE,
                        usage_type="DataTransfer-Out-Bytes", operation="DataTransfer-Out",
                        cost=cf_cost,
                        # deliberately NOT scaled: this is the mismatch signal
                        usage=Decimal("1000"),
                    )
                )

                # --- Marketplace vendor, check window only -------------------
                if in_check and days_into_check < MARKETPLACE_DAYS:
                    rows.append(
                        _row(
                            row_id=nid(), day=day, account=account, region=region,
                            service="AWSMarketplace", usage_type="BoxUsage:m5.xlarge",
                            operation="RunInstances", cost=MARKETPLACE_DAILY, usage=Decimal("24"),
                            provider=MARKETPLACE_PROVIDER, marketplace_product="Datadog Hosted Agent",
                        )
                    )

    # --- Savings Plan: purchased 500, only 200 consumed -------------------
    for day in all_days:
        if day >= CHECK_START:
            rows.append(
                _row(
                    row_id=nid(), day=day, account=ACCOUNTS[0], region=REGIONS[0],
                    service="AmazonEC2", usage_type="BoxUsage:m5.large", operation="RunInstances",
                    cost=Decimal("0.00"), usage=Decimal("0"),
                    resource_id="sp-0001",
                )
            )
            rows[-1]["savingsPlan/SavingsPlanId"] = "sp-0001"
            rows[-1]["savingsPlan/SavingsPlanType"] = "Compute"
            rows[-1]["savingsPlan/PaymentOption"] = "No Upfront"
            rows[-1]["savingsPlan/TotalCommitmentToDate"] = _d(SP_PURCHASED)
            rows[-1]["savingsPlan/UsedCommitment"] = _d(SP_USED)

    # --- Optional duplicate rows, byte-identical to existing ones ---------
    for i in range(with_duplicates):
        rows.append(dict(rows[i]))

    return rows

def write_cur_csv(rows: list[dict[str, str]], path: Path) -> Path:
    """Write rows to a CUR-shaped CSV."""
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CUR_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return path

def write_cur_gz(rows: list[dict[str, str]], path: Path) -> Path:
    import gzip

    with gzip.open(path, "wt", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CUR_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return path

def write_cur_parquet(rows: list[dict[str, str]], path: Path) -> None:
    import pyarrow as pa
    from pyarrow import parquet as pq

    table = pa.Table.from_pylist(rows)
    pq.write_table(table, path)