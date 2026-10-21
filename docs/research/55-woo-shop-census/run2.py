"""The second Indonesian sample: screen candidates in order, read one contact page when the front page
does not place a WooCommerce shop, and stop when the combined Indonesian group reaches 40.

python3 -I run2.py <candidates.json> <outdir> <state.json>
The state starts as the first sample's final decisions, so the combined count is read from it.
"""
import json, os, re, sys, time
from urllib.parse import urlsplit, urljoin
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen as S
import include as I
import run as R

BALI_SOURCES = {73, 79, 83, 87}
CONTACT = re.compile(r"contact|kontak|hubungi|tentang|about|alamat", re.I)

def front_html(outdir, key, rec):
    fronts = [r for r in rec["requests"] if r["what"] == "front"]
    if not fronts: return ""
    p = f"{outdir}/{key}.front{len(fronts) - 1}.body"
    return open(p, "rb").read().decode("utf-8", "replace") if os.path.exists(p) else ""

def robots_text(outdir, key):
    for name in ("robots1", "robots"):
        p = f"{outdir}/{key}.{name}.body"
        if os.path.exists(p):
            return open(p, "rb").read().decode("utf-8", "replace")
    return ""

def contact_link(html, host):
    for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S):
        href, text = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        u = urlsplit(urljoin(f"https://{host}/", href))
        if u.scheme != "https" or (u.hostname or "").lower() != host.lower():
            continue
        if CONTACT.search(u.path) or CONTACT.search(text):
            return (u.path or "/") + (("?" + u.query) if u.query else "")
    return None

def decide(rec, html):
    cand = rec["cand"]
    probe = dict(rec, cand=dict(cand, stratum="B" if cand["q"] in BALI_SOURCES else "I2"))
    return I.decide(probe, html, None)

def main():
    cf, outdir, sf = sys.argv[1:4]
    os.makedirs(outdir, exist_ok=True)
    cands = json.load(open(cf))
    state = json.load(open(sf))
    state.setdefault("stops", {})
    seen = set(c["host"].removeprefix("www.") for c in cands)
    i = 0
    while i < len(cands):
        c, _ = R.counts(state)
        if c["ID"] >= 40:
            state["stops"]["I2"] = {"after": i, "counts": c}; break
        cand = cands[i]; i += 1
        key = re.sub(r"[^a-z0-9.-]", "_", cand["host"])
        if key in state["decisions"]:
            continue
        rec = S.screen(cand, outdir, None)
        html = front_html(outdir, key, rec)
        d = decide(rec, html)
        if d.get("woo") and d.get("reason") == "origin undetermined" and len(rec["requests"]) < S.BUDGET and not rec.get("stopped"):
            host = rec.get("origin") or cand["host"]
            path = contact_link(html, host)
            rt = robots_text(outdir, key)
            allowed = path is not None and (rt == "" or S.robots_allows(rt, path))
            rec["contact"] = {"path": path, "allowed": allowed}
            if allowed:
                time.sleep(S.SPACING)
                r = S.honest(host, path, "text/html,application/xhtml+xml,*/*;q=0.8")
                cls = S.classify(r, listing=False)
                rec["requests"].append({"what": "contact", "host": host, "path": path, **S.save(outdir, key, "contact", r), "class": cls})
                if cls == "Readable":
                    d = decide(rec, html + "\n" + r["body"].decode("utf-8", "replace"))
                    d["origin_from_contact_page"] = True
        rec["n_requests"] = len(rec["requests"])
        with open(f"{outdir}/{key}.json", "w") as f: json.dump(rec, f)
        d["cand"] = cand; d["outdir"] = outdir
        if d.get("included") and d["origin"]["group"] != "ID":
            d["included"] = False; d["reason"] = "placed outside Indonesia; not added"
        state["decisions"][key] = d
        off = rec.get("offsite")
        if off and off.removeprefix("www.") not in seen:
            seen.add(off.removeprefix("www."))
            cands.insert(i, {**cand, "host": off, "via": "redirect from " + cand["host"]})
        json.dump(state, open(sf, "w"))
        print("I2", i, cand["host"], d.get("reason"), (d.get("origin") or {}).get("region", ""), R.counts(state)[0]["ID"], flush=True)
        time.sleep(0.5)
    else:
        state["stops"]["I2"] = {"after": i, "counts": R.counts(state)[0], "exhausted": True}
    json.dump(state, open(sf, "w"))
    print("STOP", state["stops"]["I2"])

if __name__ == "__main__":
    main()
