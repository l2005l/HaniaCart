"""Offline check of fetch.py with fake chain data: python -m unittest prices/test_fetch.py"""
import json
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

    def list_chains(self):
        mk = lambda slug, he, fam="cerberus": NS(slug=slug, name_he=he, implemented=True, sector="supermarket", portal_family=fam)
        return [mk("yochananof", "יוחננוף"), mk("rami-levy", "רמי לוי"), mk("carrefour", "קרפור"), mk("victory", "ויקטורי", "laib")]

    def get_stores(self, chain):
        if chain == self.fail:
            raise RuntimeError("portal down")
        return NS(stores=[
            NS(store_id="7", name="סניף באר שבע", address="", city="באר שבע", sub_chain_name=None),
            NS(store_id="12", name="מנהטן", address="שד' ירושלים", city="246", sub_chain_name=None),
            NS(store_id="31", name="פארק נועם נתיבות", address="", city="", sub_chain_name=None),
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

    def towns(self):
        geo = {"באר שבע": (31.25, 34.79), "נתיבות": (31.42, 34.59)}
        return fetch.Towns({}, {"246": "נתיבות"}, lambda c: geo.get(c))

    def test_branches_defaults_and_wanted_prices(self):
        cfgs = [{"chain": "yochananof", "label": "יוחננוף", "keys": ["נתיבות"], "prefer": ["מנהטן"], "city_code": "246"},
                {"chain": "victory", "label": "ויקטורי", "keys": ["נתיבות"]}]
        sql, status = fetch.run(FakeIlp(), cfgs, wanted=["rami-levy:7", "victory:3", "rami-levy:7"], now=NOW, towns=self.towns())
        con = self.db(sql)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM branches").fetchone()[0], 9, "three branches in each of three chains, Laib left to the Worker")
        b = con.execute("SELECT city, lat FROM branches WHERE sid='yochananof:31'").fetchone()
        self.assertEqual(b, ("נתיבות", 31.42), "a branch with no town takes one found in its name; a town code is resolved")
        self.assertEqual(json.loads(con.execute("SELECT v FROM kv WHERE k='prices:defaults'").fetchone()[0]), ["yochananof:12"])
        sids = [r[0] for r in con.execute("SELECT DISTINCT sid FROM sprices ORDER BY sid")]
        self.assertEqual(sids, ["rami-levy:7", "yochananof:12"])
        flour = con.execute("SELECT price, promo, pprice FROM sprices WHERE sid='yochananof:12' AND code='07290000000017'").fetchone()
        self.assertEqual(flour, (16.9, "2 ב-30", 15.0))
        milk = con.execute("SELECT promo, pprice FROM sprices WHERE code='07290000000024' LIMIT 1").fetchone()
        self.assertEqual(milk, ("", None), "expired promotion ignored")
        self.assertEqual(con.execute("SELECT lat FROM places WHERE city='באר שבע'").fetchone()[0], 31.25)

    def test_failed_branch_keeps_old_prices_and_reports(self):
        first, _ = fetch.run(FakeIlp(), [], wanted=["carrefour:7"], now=NOW, towns=self.towns())
        con = self.db(first)
        second, status = fetch.run(FakeIlp(fail="carrefour"), [], wanted=["carrefour:7"], now=NOW, towns=self.towns())
        con.executescript("\n".join(second))
        self.assertEqual(con.execute("SELECT COUNT(*) FROM sprices").fetchone()[0], 2)
        self.assertIn("portal down", status["branches"]["קרפור"]["error"])

    def test_no_store_lists_candidates(self):
        sql, status = fetch.run(FakeIlp(), [{"chain": "carrefour", "label": "קרפור", "keys": ["אופקים"]}], now=NOW, towns=self.towns())
        self.assertEqual(status["chains"]["קרפור"]["error"], "no matching store")


if __name__ == "__main__":
    unittest.main()
