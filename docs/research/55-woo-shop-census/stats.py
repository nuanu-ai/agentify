"""The census's counts other than the verdict, from the extraction's output and the verdict script's output.

python3 -I stats.py <shops.json> <verdicts.json>
"""
import json, math, re, statistics, sys
from collections import Counter

def wilson(k, n):
    if n == 0: return (0, 0)
    z = 1.96; p = k / n
    d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(100 * max(0, c - h)), round(100 * min(1, c + h)))

def sh(k, n):
    if n == 0: return "—"
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {round(100 * k / n)}% (95% interval {lo}–{hi}%)"

data = json.load(open(sys.argv[1])); verdicts = json.load(open(sys.argv[2]))
shops = data["shops"]; screened = data["screened"]
vrow = {r["id"]: r for r in verdicts["rows"]}
GROUPS = {
    "Bali": lambda s: s["group"] == "ID" and s.get("region") == "Bali",
    "Indonesia outside Bali": lambda s: s["group"] == "ID" and s.get("region") != "Bali",
    "Indonesia": lambda s: s["group"] == "ID",
    "United States": lambda s: s["group"] == "US",
    "Europe": lambda s: s["group"] == "EU",
}
BLOCKED = {"Challenged", "Rate-limited", "Refused by a firewall"}
out = {}

# Screening record.
out["screening"] = {
    "by stratum and reason": {st: dict(Counter(x["reason"] for x in screened if x["stratum"] == st)) for st in sorted(set(x["stratum"] for x in screened))},
    "requested candidates": sum(1 for x in screened if x["requested"]),
    "requests sent": sum(x.get("n_requests") or 0 for x in screened),
    "platforms of requested candidates": dict(Counter(x.get("platform") for x in screened if x["requested"])),
    "front page challenged or rate-limited": sum(1 for x in screened if x.get("front_class") in ("Challenged", "Rate-limited")),
}
# P12: WooCommerce among candidates that sell online from their own site, by origin.
p12 = {}
for name, f in [("Bali", lambda x: x.get("group") == "ID" and x.get("region") == "Bali"),
                ("Indonesia outside Bali", lambda x: x.get("group") == "ID" and x.get("region") != "Bali"),
                ("United States", lambda x: x.get("group") == "US"), ("Europe", lambda x: x.get("group") == "EU")]:
    sells = [x for x in screened if x["requested"] and x.get("sells") and f(x)]
    p12[name] = {"WooCommerce": sh(sum(1 for x in sells if x["platform"] == "WooCommerce"), len(sells)),
                 "platforms": dict(Counter(x["platform"] for x in sells))}
out["WooCommerce among merchants selling from their own site"] = p12

def products_of(s):
    return [p for pg in s["pages"] for p in pg] if s["honestClass"] == "Readable" else []

def currency(s):
    ps = products_of(s) or s.get("probeProducts") or []
    if not ps: return None, None
    pr = ps[0].get("prices", {})
    return pr.get("currency_code"), pr.get("currency_minor_unit")

def managed(p):
    t = (p.get("stock_availability") or {}).get("text") or ""
    return p.get("low_stock_remaining") is not None or t != ""

for name, f in GROUPS.items():
    g = [s for s in shops if f(s)]
    n = len(g)
    read = [s for s in g if currency(s)[0] is not None]
    cur = Counter(currency(s)[0] for s in read)
    dec = Counter(f"{currency(s)[0]} at {currency(s)[1]}" for s in read)
    idr = [s for s in read if currency(s)[0] == "IDR"]
    listing = [s for s in g if s["honestClass"] == "Readable"]
    over = [s for s in listing if (s["total"] is not None and s["total"] > 200) or (s["total"] is None and len(s["pages"]) >= 3 and len(s["pages"][-1]) > 0)]
    sizes = [s["total"] if s["total"] is not None else sum(len(p) for p in s["pages"]) for s in listing]
    prods = [p for s in listing for p in products_of(s)]
    simple = [p for p in prods if p.get("type") == "simple"]
    simple_in = [p for p in simple if p.get("is_in_stock") and not p.get("is_on_backorder")]
    vd = Counter(vrow[s["id"]]["verdict"] for s in g)
    main_reason = Counter()
    for s in g:
        r = vrow[s["id"]]
        if r["verdict"].startswith("cannot") or r["verdict"].startswith("unknown"):
            main_reason[r["reasons"][0] if r["reasons"] else r["verdict"]] += 1
    plugins = Counter(p for s in g for p in set(s["plugins"]))
    exts = Counter(p for s in g for p in set(s["storeApiExtensions"]))
    hosting = Counter(h for s in g for h in set(s["hosting"]))
    suffix = [s for s in g if s["priceSuffixes"]]
    differ = [(s["id"], s["honestClass"], s["connectorClass"]) for s in g if s["connectorClass"] is not None and s["connectorClass"] != s["honestClass"]]
    out[name] = {
        "included shops": n,
        "verdicts": dict(vd),
        "could, conditionally": sh(vd.get("could, conditionally", 0), n),
        "first reason of cannot and unknown": dict(main_reason),
        "currency": {k: sh(v, len(read)) for k, v in cur.items()},
        "currency and decimals": dict(dec),
        "rupiah shops with no decimals": sh(sum(1 for s in idr if currency(s)[1] == 0), len(idr)),
        "dollar shops at two decimals": sh(sum(1 for s in read if currency(s) == ("USD", 2)), len(read)),
        "over 200 products": sh(len(over), len(listing)),
        "median catalogue size": statistics.median(sizes) if sizes else None,
        "catalogue sizes": sorted(sizes),
        "simple products of all listed": sh(len(simple), len(prods)),
        "managed stock (inferred) among simple products in stock": sh(sum(1 for p in simple_in if managed(p)), len(simple_in)),
        "sold individually among products": sh(sum(1 for p in prods if p.get("sold_individually")), len(prods)),
        "weight or dimensions filled among products": sh(sum(1 for p in prods if p.get("weight") or any((p.get("dimensions") or {}).values())), len(prods)),
        "price suffix": sh(len(suffix), n),
        "suffix texts": sorted(set(t for s in suffix for t in s["priceSuffixes"])),
        "tax wording outside a suffix": sh(sum(1 for s in g if s["taxWordingElsewhere"]), n),
        "plain permalinks or sub-path": sh(sum(1 for s in g if s["honestClass"] in ("Other", "No route", "Redirected", "Unreadable list") and s.get("probeClass") in ("Readable", "Empty")), n),
        "robots.txt disallows the listing": sh(sum(1 for s in g if s["robotsDisallowsListing"]), n),
        "listing blocked (step 1)": sh(sum(1 for s in g if s["honestClass"] in BLOCKED), n),
        "readable by the honest request": sh(sum(1 for s in g if s["honestClass"] == "Readable"), n),
        "readable by the connector's own request": sh(sum(1 for s in g if s["connectorClass"] == "Readable"), n),
        "honest answered, connector refused": sh(sum(1 for s in g if s["honestClass"] == "Readable" and s["connectorClass"] not in (None, "Readable")), n),
        "classes differ": differ,
        "multi-currency plugin visible": sh(sum(1 for s in g if s["multiCurrencyPlugin"]), n),
        "listing served from a cache": sh(sum(1 for s in g if s["listingCacheHit"]), n),
        "plugins (shops)": {k: sh(v, n) for k, v in plugins.most_common(25)},
        "Store API extensions (shops)": {k: sh(v, n) for k, v in exts.most_common(10)},
        "hosting signals (shops)": {k: sh(v, n) for k, v in hosting.most_common()},
        "countries": dict(Counter(s.get("country") for s in g)) if name == "Europe" else None,
    }
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
