"""Turn the screener's raw records into the inputs of the verdict script and the census's other counts.

python3 -I extract.py <state.json> <outdir>... > shops.json
Every shop is written under an opaque id; the address stays in a separate key file.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import include as I

PLUGIN = re.compile(r"/wp-content/plugins/([A-Za-z0-9_.-]+)/")
MULTI_CURRENCY = {"woocommerce-multi-currency", "woocommerce-currency-switcher", "currency-switcher-woocommerce",
                  "woo-multi-currency", "woocommerce-multilingual", "wpml-multilingual-cms", "aelia-currency-switcher",
                  "woocommerce-aelia-currencyswitcher", "currency-switcher", "yith-multi-currency-switcher-for-woocommerce",
                  "woocommerce-payments", "fox-currency-switcher"}
TAX_WORDS = re.compile(r"\b(MwSt|VAT|BTW|TTC|HT|IVA|PPN|tax)\b", re.I)

def hosting(headers):
    h = {k: v for k, v in headers}
    def has(k): return any(x == k for x, _ in headers)
    sig = set()
    if has("cf-ray") or h.get("server", "").lower() == "cloudflare": sig.add("Cloudflare")
    if has("x-sucuri-id") or has("x-sucuri-cache"): sig.add("Sucuri")
    if any(k.startswith("x-qc-") for k, _ in headers): sig.add("QUIC.cloud")
    if has("x-amz-cf-id"): sig.add("Amazon CloudFront")
    via = (h.get("via", "") + " " + h.get("x-cache", "") + " " + h.get("x-served-by", "")).lower()
    if "varnish" in via or has("x-varnish"): sig.add("Varnish")
    if "fastly" in via or has("x-fastly-request-id"): sig.add("Fastly")
    if "akamai" in via or has("x-akamai-transformed"): sig.add("Akamai")
    if has("x-kinsta-cache"): sig.add("Kinsta cache")
    if any(k.startswith("x-hcdn-") for k, _ in headers): sig.add("Hostinger CDN")
    if has("x-proxy-cache"): sig.add("SiteGround proxy cache")
    if has("x-ac"): sig.add("WordPress.com edge cache")
    srv = h.get("server", "").lower()
    if "litespeed" in srv or has("x-litespeed-cache"): sig.add("LiteSpeed")
    if srv.startswith("nginx"): sig.add("server nginx")
    if srv.startswith("apache"): sig.add("server Apache")
    if srv.startswith("openresty"): sig.add("server openresty")
    if has("x-powered-by") and "wp engine" in h.get("x-powered-by", "").lower(): sig.add("WP Engine")
    return sorted(sig)

def cache_hit(headers):
    h = {k: v.lower() for k, v in headers}
    return any("hit" in h.get(k, "") for k in ("x-cache", "cf-cache-status", "x-litespeed-cache", "x-proxy-cache", "x-kinsta-cache"))

PLATFORMS = [
    ("Shopify", re.compile(r"cdn\.shopify\.com|Shopify\.theme", re.I), ["x-shopid", "x-shopify-stage"]),
    ("Squarespace", re.compile(r"static1\.squarespace\.com", re.I), []),
    ("Wix", re.compile(r"static\.wixstatic\.com|wix-warmup-data", re.I), ["x-wix-request-id"]),
    ("BigCommerce", re.compile(r"cdn11\.bigcommerce\.com", re.I), []),
    ("Webflow", re.compile(r"data-wf-site", re.I), []),
    ("Magento", re.compile(r"Magento|/static/version\d+/frontend/|mage/cookies", re.I), []),
    ("OpenCart", re.compile(r"catalog/view/theme", re.I), []),
    ("PrestaShop", re.compile(r"prestashop", re.I), []),
]
SELLS = re.compile(r"add[- _]to[- _]cart|/cart\b|/checkout\b|keranjang|warenkorb|panier|carrito|carrello|winkelwagen|koszyk|basket", re.I)

def platform(rec, html):
    if rec.get("woo"): return "WooCommerce"
    hdrs = []
    for r in rec["requests"]:
        if r["what"] == "front": hdrs = [k for k, _ in r.get("headers", [])] + [f"{k}:{v}".lower() for k, v in r.get("headers", [])]
    for name, rx, hk in PLATFORMS:
        if rx.search(html) or any(k in hdrs for k in hk) or (name == "Squarespace" and any("server:squarespace" in x for x in hdrs)) or (name == "Shopify" and any(x.startswith("powered-by:shopify") for x in hdrs)):
            return name
    if "/wp-content/" in html: return "WordPress without WooCommerce"
    return "other"

def body(outdir, key, name):
    p = f"{outdir}/{key}.{name}.body"
    return open(p, "rb").read() if os.path.exists(p) else b""

def main():
    state = json.load(open(sys.argv[1])); outdirs = sys.argv[2:]
    shops = []; screened = []; keys = {}
    n = 0
    for key, d in state["decisions"].items():
        outdir = next((o for o in outdirs if os.path.exists(f"{o}/{key}.json")), None)
        if outdir is None:
            screened.append({"stratum": d["cand"]["stratum"], "q": d["cand"]["q"], "reason": d["reason"], "requested": False})
            continue
        rec = json.load(open(f"{outdir}/{key}.json"))
        fronts = [r for r in rec["requests"] if r["what"] == "front"]
        html = body(outdir, key, f"front{len(fronts)-1}").decode("utf-8", "replace") if fronts else ""
        rec["woo"] = d.get("woo")
        o = d.get("origin") or (I.origin(rec.get("origin") or rec["cand"]["host"], html, rec["cand"]["stratum"], rec["cand"]["q"]) if html else {"group": None})
        plat = platform(rec, html)
        screened.append({"stratum": d["cand"]["stratum"], "q": d["cand"]["q"], "reason": d["reason"], "requested": True,
                         "platform": plat, "sells": plat in ("WooCommerce", "Shopify", "BigCommerce", "Magento", "OpenCart", "PrestaShop") or (plat in ("Squarespace", "Wix", "Webflow") and bool(SELLS.search(html))),
                         "group": o.get("group"), "region": o.get("region"), "country": o.get("country"),
                         "front_class": rec.get("front_class") or (rec.get("stopped", "").split(" ", 1)[1] if rec.get("stopped", "").startswith("front ") else None), "honest_class": rec.get("honest_class"), "connector_class": rec.get("connector_class"),
                         "stopped": rec.get("stopped", ""), "n_requests": rec.get("n_requests")})
        if not d.get("included"): continue
        n += 1
        sid = f"{o['group']}-{n:03d}"
        keys[sid] = rec.get("origin") or rec["cand"]["host"]
        pages = []; total = None; unread = False
        for r in rec["requests"]:
            if r["what"].startswith("listing") and r.get("class") == "Readable":
                pages.append(json.loads(body(outdir, key, r["what"])))
                if r["what"] == "listing1":
                    t = [v for k, v in r.get("headers", []) if k == "x-wp-total"]
                    total = int(t[0]) if t and t[0].strip().isdigit() else None
        if any("unread" in x for x in rec.get("notes", [])): unread = True
        probe = rec.get("probe") or {}
        probe_products = []
        for r in rec["requests"]:
            if r["what"].startswith("probe") and r.get("class") == "Readable":
                probe_products = json.loads(body(outdir, key, r["what"]))
        plugins = sorted(set(m.group(1).lower() for m in PLUGIN.finditer(html)))
        ext = sorted(set(k for p in (pages[0] if pages else []) for k in (p.get("extensions") or {}).keys()))
        host_sig = sorted(set(s for r in rec["requests"] if r["what"] in ("front", "listing1") for s in hosting(r.get("headers", []))))
        listing_hit = any(cache_hit(r.get("headers", [])) for r in rec["requests"] if r["what"] == "listing1")
        products = [p for pg in pages for p in pg]
        suffixes = sorted(set(re.sub(r"<[^>]+>", "", m.group(1)).strip() for p in products for m in re.finditer(r'<small class="woocommerce-price-suffix">(.*?)</small>', p.get("price_html", ""), re.S)))
        def outside_suffix(h):
            return re.sub(r"<[^>]+>", " ", re.sub(r'<small class="woocommerce-price-suffix">.*?</small>', "", h, flags=re.S))
        tax_words_elsewhere = any(TAX_WORDS.search(outside_suffix(p.get("price_html", ""))) for p in products)
        shops.append({
            "id": sid, "group": o["group"], "region": o.get("region"), "country": o.get("country"),
            "stratum": d["cand"]["stratum"],
            "robotsDisallowsListing": rec.get("robots_allows_listing") is False,
            "frontClass": rec.get("front_class"), "honestClass": rec.get("honest_class"), "connectorClass": rec.get("connector_class"),
            "probeWhat": probe.get("what"), "probeClass": probe.get("class"), "probeProducts": probe_products,
            "total": total, "pages": pages, "unreadPages": unread,
            "shopOrigin": "https://shop.example.com",
            "plugins": plugins, "storeApiExtensions": ext, "hosting": host_sig, "listingCacheHit": listing_hit,
            "multiCurrencyPlugin": bool(set(plugins) & MULTI_CURRENCY), "priceSuffixes": suffixes, "taxWordingElsewhere": tax_words_elsewhere,
            "requests": rec.get("n_requests"), "stopped": rec.get("stopped", ""),
        })
    json.dump({"shops": shops, "screened": screened, "stops": state.get("stops", {})}, sys.stdout)
    json.dump(keys, open(os.path.join(os.path.dirname(sys.argv[1]), "shop-keys.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
