"""Offline check of fetch.py with fake chain data: python -m unittest prices/test_fetch.py"""
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).parent))
import fetch  # noqa: E402

ROOT = Path(__file__).parent.parent
NOW = datetime(2026, 10, 13, 12, 0)


def item(code, name, price, gtin=True):
    return NS(item_code=code, gtin=code.zfill(14) if gtin else None, name=name, price=Decimal(price), quantity=Decimal("1"), unit_qty="ק\"ג")


class FakeIlp:
    def __init__(self, fail=None):
        self.fail = fail

    def get_stores(self, chain):
        if chain == self.fail:
            raise RuntimeError("portal down")
        return NS(stores=[
            NS(store_id="7", name="סניף באר שבע", address="", city="באר שבע", sub_chain_name=None),
            NS(store_id="12", name="נתיבות מנהטן", address="שד' ירושלים", city="נתיבות", sub_chain_name=None),
            NS(store_id="31", name="פארק נועם", address="", city="", sub_chain_name=None),
        ])

    def get_prices(self, chain, store_id):
        return NS(items=[item("7290000000017", "קמח כוסמין זהב 1 ק\"ג", "16.90"), item("123", "עגבניות", "5.90", gtin=False), item("7290000000024", "חלב 3% טרה", "6.20")])

    def get_promos(self, chain, store_id):
        return NS(promotions=[
            NS(is_coupon=False, end_time=NOW + timedelta(days=3), start_time=NOW - timedelta(days=1), club_id="0 - כלל הלקוחות", description="2 ב-30", discounted_price=Decimal("30"), min_qty=Decimal("2"),
               items=[NS(gtin="07290000000017", discounted_price=None, min_qty=None)]),
            NS(is_coupon=False, end_time=NOW - timedelta(days=1), start_time=None, club_id=None, description="ישן", discounted_price=Decimal("1"), min_qty=None,
               items=[NS(gtin="07290000000024", discounted_price=None, min_qty=None)]),
        ])


class FetchTest(unittest.TestCase):
    def db(self, sql):
        con = sqlite3.connect(":memory:")
        for f in sorted((ROOT / "migrations").glob("*.sql")):
            con.executescript(f.read_text(encoding="utf-8"))
        con.executescript("\n".join(sql))
        return con

    def test_loads_matching_stores_with_promos(self):
        cfgs = [{"chain": "yochananof", "label": "יוחננוף", "keys": ["נתיבות"], "prefer": ["מנהטן"]},
                {"chain": "rami-levy", "label": "רמי לוי", "keys": ["נועם"]}]
        sql, status = fetch.run(FakeIlp(), cfgs, now=NOW)
        con = self.db(sql)
        rows = con.execute("SELECT chain, code, price, promo, pprice, store FROM prices ORDER BY chain, code").fetchall()
        self.assertEqual(len(rows), 4)  # two barcoded items per store; the loose one is skipped
        flour = [r for r in rows if r[0] == "יוחננוף" and r[1] == "07290000000017"][0]
        self.assertEqual((flour[2], flour[3], flour[4]), (16.9, "2 ב-30", 15.0))
        self.assertEqual(flour[5], "נתיבות מנהטן")
        milk = [r for r in rows if r[1] == "07290000000024"][0]
        self.assertEqual((milk[3], milk[4]), ("", None), "expired promotion ignored")
        self.assertEqual(status["chains"]["רמי לוי"]["store_id"], "31")

    def test_failed_chain_keeps_old_prices_and_reports(self):
        cfgs = [{"chain": "victory", "label": "ויקטורי", "keys": ["נתיבות"]}]
        first, _ = fetch.run(FakeIlp(), cfgs, now=NOW)
        con = self.db(first)
        second, status = fetch.run(FakeIlp(fail="victory"), cfgs, now=NOW)
        con.executescript("\n".join(second))
        self.assertEqual(con.execute("SELECT COUNT(*) FROM prices").fetchone()[0], 2)
        self.assertIn("portal down", status["chains"]["ויקטורי"]["error"])
        self.assertIn("portal down", con.execute("SELECT v FROM kv WHERE k='prices:status'").fetchone()[0])

    def test_no_store_lists_candidates(self):
        sql, status = fetch.run(FakeIlp(), [{"chain": "carrefour", "label": "קרפור", "keys": ["אופקים"]}], now=NOW)
        self.assertEqual(status["chains"]["קרפור"]["error"], "no matching store")


if __name__ == "__main__":
    unittest.main()
