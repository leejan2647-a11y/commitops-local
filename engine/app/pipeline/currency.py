"""Explicit supported currency for the actual current/reference population."""

from app.pipeline.money import MoneyInputError


class CurrencyInputError(MoneyInputError):
    def __init__(self, invalid_rows=None):
        self.diagnostics = {
            "code": "cur_currency_unavailable",
            "invalidRows": invalid_rows,
            "column": "lineItem/CurrencyCode",
            "differingFields": ["lineItem/CurrencyCode"],
            "message": "The applicable current or reference observations do not consistently declare supported USD.",
            "recovery": "Export consistently declared USD in lineItem/CurrencyCode (CUR2 line_item_currency_code) for the selected window and comparison scope, then rerun. Missing, blank, mixed or non-USD amounts cannot be converted or relabeled.",
        }
        ValueError.__init__(self, self.diagnostics["message"] + " " + self.diagnostics["recovery"])


def unsupported_count(con, scope, table="cur"):
    return con.execute(
        f'SELECT count(*) FROM "{table}" WHERE ({scope}) '
        "AND COALESCE(TRIM(CAST(\"lineItem/CurrencyCode\" AS VARCHAR)), '') != 'USD'"
    ).fetchone()[0]


def validate(con, scope, table="cur"):
    invalid = unsupported_count(con, scope, table)
    if invalid:
        raise CurrencyInputError(invalid)
    rows = con.execute(f'SELECT count(*) FROM "{table}" WHERE ({scope})').fetchone()[0]
    return {
        "status": "verified" if rows else "unavailable",
        "currency": "USD" if rows else None,
        "observed_rows": rows,
    }
