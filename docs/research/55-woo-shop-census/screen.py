"""Screen candidate shops in order, as the census note's conduct section says.

Runs on the test host: python3 -I screen.py <candidates.json> <state.json> <outdir> <stratum>
Every request is a GET written byte for byte over TLS to a resolved public address.
"""
import http.client, ipaddress, json, os, re, socket, ssl, sys, time
from urllib.parse import urlsplit, urljoin

UA = "AgentifyResearch/1.0 (WooCommerce shop census; +https://agentify.ad)"
TIMEOUT = 15.0
MAX_BODY = 10 * 1024 * 1024
SPACING = 1.5
BUDGET = 7
LISTING = "/wp-json/wc/store/v1/products"

SLD = {"co","com","net","org","or","web","my","ac","go","sch","gov","biz","id","ltd","plc"}
def regdom(host):
    host = (host or "").lower().strip(".")
    if host.startswith("www."): host = host[4:]
    p = host.split(".")
    if len(p) >= 3 and len(p[-1]) == 2 and p[-2] in SLD: return ".".join(p[-3:])
    return ".".join(p[-2:])

def public_addresses(host):
    out = []
    for fam, _, _, _, sa in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        ip = ipaddress.ip_address(sa[0])
        if ip.is_global and sa[0] not in out: out.append(sa[0])
    return out

CTX = ssl.create_default_context()

def get(host, path, headers):
    """One GET. Returns dict(status, headers, body, error)."""
    t0 = time.time()
    try:
        addrs = public_addresses(host)
        if not addrs: return {"error": "no public address", "ms": 0}
        addr = addrs[0]
        raw = socket.create_connection((addr, 443), timeout=TIMEOUT)
        sock = CTX.wrap_socket(raw, server_hostname=host)
        req = f"GET {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers) + "\r\n"
        sock.sendall(req.encode("latin-1"))
        resp = http.client.HTTPResponse(sock, method="GET")
        resp.begin()
        chunks = []; n = 0
        while True:
            if time.time() - t0 > TIMEOUT: raise TimeoutError("timeout")
            c = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
            if not c: break
            n += len(c)
            if n > MAX_BODY: raise ValueError("body over 10 MB")
            chunks.append(c)
        hdrs = [(k.lower(), v) for k, v in resp.getheaders()]
        sock.close()
        return {"status": resp.status, "headers": hdrs, "body": b"".join(chunks), "addr": addr, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 - every failure is a recorded outcome
        return {"error": f"{type(e).__name__}: {e}"[:300], "ms": int((time.time() - t0) * 1000)}

def honest(host, path, accept):
    return get(host, path, [("accept", accept), ("host", host), ("user-agent", UA), ("Connection", "keep-alive")])

def connector(host, path):
    return get(host, path, [("accept", "application/json"), ("host", host), ("Connection", "keep-alive")])

def hget(r, name):
    return [v for k, v in r.get("headers", []) if k == name]

CHALLENGE = re.compile(rb"<title>\s*(Just a moment\.\.\.|Attention Required!|One moment, please|Checking your browser|DDoS-Guard|Access denied \| [^<]* used Cloudflare|Sucuri WebSite Firewall - Access Denied)|sgcaptcha|Sucuri WebSite Firewall|wordfence|Imunify360|imunify360|bot-protection|challenge-platform|cf-chl-|hcdn-challenge|__cf_chl", re.I)
MAINT = re.compile(rb"maintenance|perbaikan|sedang dalam pemeliharaan", re.I)

def wp_error(body):
    try:
        d = json.loads(body)
        return isinstance(d, dict) and "code" in d
    except Exception:  # noqa: BLE001
        return False

def classify(r, listing=True):
    if "error" in r:
        return "Unreachable"
    st, body = r["status"], r["body"]
    if hget(r, "cf-mitigated") and "challenge" in " ".join(hget(r, "cf-mitigated")).lower(): return "Challenged"
    if st != 200 and st not in (301, 302, 303, 307, 308, 404) and CHALLENGE.search(body[:200000]): return "Challenged"
    if listing and st == 200 and not body.lstrip()[:1] in (b"[", b"{") and CHALLENGE.search(body[:200000]): return "Challenged"
    if st == 429: return "Rate-limited"
    if st == 503 and MAINT.search(body[:200000]) and not wp_error(body): return "Unreachable"
    if 300 <= st < 400: return "Redirected"
    if not listing:
        return "Readable" if st == 200 else ("Refused by a firewall" if st in (401, 403, 406, 503) else "Other")
    if st == 200:
        try:
            d = json.loads(body)
        except Exception:  # noqa: BLE001
            return "Unreadable list"
        if isinstance(d, list):
            return "Empty" if len(d) == 0 else "Readable"
        return "Unreadable list"
    if st in (401, 403) and wp_error(body): return "Closed by the shop"
    if st in (401, 403, 406, 503): return "Refused by a firewall"
    if st == 404 and wp_error(body):
        try:
            if json.loads(body).get("code") == "rest_no_route": return "No route"
        except Exception:  # noqa: BLE001
            pass
    return "Other"

def robots_allows(text, path):
    """RFC 9309: our group, else '*'; longest match wins; Allow wins ties."""
    groups = []; cur = None; last_was_agent = False
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" not in line: continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if not last_was_agent:
                cur = {"agents": [], "rules": []}; groups.append(cur)
            cur["agents"].append(v.lower()); last_was_agent = True
        elif k in ("allow", "disallow") and cur is not None:
            cur["rules"].append((k, v)); last_was_agent = False
        else:
            last_was_agent = False
    mine = [g for g in groups if "agentifyresearch" in g["agents"]]
    star = [g for g in groups if "*" in g["agents"]]
    use = mine or star
    rules = [r for g in use for r in g["rules"]]
    best = None
    for k, v in rules:
        if v == "": continue
        pat = re.escape(v).replace(r"\*", ".*")
        if pat.endswith(r"\$"): pat = pat[:-2] + "$"
        if re.match(pat, path):
            L = len(v)
            if best is None or L > best[0] or (L == best[0] and k == "allow"):
                best = (L, k)
    return best is None or best[1] == "allow"

WOO_MARK = re.compile(rb"/wp-content/plugins/woocommerce/|<body[^>]*class=[\"'][^\"']*\bwoocommerce\b", re.I)

def save(outdir, key, name, r):
    meta = {k: v for k, v in r.items() if k != "body"}
    if "body" in r:
        with open(f"{outdir}/{key}.{name}.body", "wb") as f: f.write(r["body"])
        meta["bytes"] = len(r["body"])
    return meta

def screen(cand, outdir, deadline_hosts):
    host0 = cand["host"]; key = re.sub(r"[^a-z0-9.-]", "_", host0)
    rec = {"cand": cand, "requests": [], "notes": []}
    n = 0
    def spend():
        nonlocal n
        if n > 0: time.sleep(SPACING)
        n += 1
    def stop_here(cls):
        return cls in ("Challenged", "Rate-limited")
    # 1. front page with up to two same-domain redirects
    host = host0; path = "/"; hops = 0; front = None
    while True:
        spend(); r = honest(host, path, "text/html,application/xhtml+xml,*/*;q=0.8")
        cls = classify(r, listing=False)
        rec["requests"].append({"what": "front", "host": host, "path": path, **save(outdir, key, f"front{hops}", r), "class": cls})
        front = r
        if stop_here(cls):
            rec["stopped"] = f"front {cls}"; return rec
        if "error" not in r and 300 <= r["status"] < 400 and hops < 2:
            loc = (hget(r, "location") or [""])[0]
            tgt = urlsplit(urljoin(f"https://{host}{path}", loc))
            if tgt.scheme == "https" and tgt.hostname and regdom(tgt.hostname) == regdom(host):
                host = tgt.hostname.lower(); path = tgt.path or "/"
                if tgt.query: path += "?" + tgt.query
                hops += 1; continue
            if tgt.hostname and regdom(tgt.hostname) != regdom(host):
                rec["offsite"] = tgt.hostname.lower()
        break
    rec["origin"] = host
    if "error" in front:
        rec["front_class"] = "Unreachable"; rec["stopped"] = "front unreachable"; return rec
    if rec.get("offsite") and rec["requests"][-1]["class"] == "Redirected":
        rec["front_class"] = "Redirected"; rec["stopped"] = "front redirects to another domain"; return rec
    body = front.get("body", b"") if "error" not in front else b""
    rec["front_class"] = rec["requests"][-1]["class"]
    woo_html = bool(WOO_MARK.search(body))
    rec["woo_html"] = woo_html
    if "error" in front or rec["front_class"] == "Redirected":
        rec["notes"].append("front page unread")
    # 2. robots.txt (one same-domain redirect)
    spend(); rr = honest(host, "/robots.txt", "text/plain,*/*")
    rcls = classify(rr, listing=False)
    rec["requests"].append({"what": "robots", "host": host, **save(outdir, key, "robots", rr), "class": rcls})
    if stop_here(rcls): rec["stopped"] = f"robots {rcls}"; return rec
    rhost = host
    if "error" not in rr and 300 <= rr["status"] < 400:
        loc = (hget(rr, "location") or [""])[0]; tgt = urlsplit(urljoin(f"https://{host}/robots.txt", loc))
        if tgt.scheme == "https" and tgt.hostname and regdom(tgt.hostname) == regdom(host) and n < BUDGET:
            spend(); rr = honest(tgt.hostname, tgt.path or "/robots.txt", "text/plain,*/*"); rcls = classify(rr, listing=False)
            rec["requests"].append({"what": "robots-hop", "host": tgt.hostname, **save(outdir, key, "robots1", rr), "class": rcls})
            if stop_here(rcls): rec["stopped"] = f"robots {rcls}"; return rec
    if "error" in rr: robots = "disallow-all"
    elif rr["status"] >= 500: robots = "disallow-all"
    elif 400 <= rr["status"] < 500: robots = "none"
    elif rr["status"] == 200: robots = rr["body"].decode("utf-8", "replace")
    else: robots = "none"
    def allowed(p):
        if robots == "disallow-all": return False
        if robots == "none": return True
        return robots_allows(robots, p)
    rec["robots"] = "disallow-all" if robots == "disallow-all" else ("none" if robots == "none" else "rules")
    rec["robots_allows_listing"] = allowed(LISTING)
    if not allowed(LISTING):
        rec["stopped"] = "robots disallows listing"; return rec
    # 3. honest listing
    spend(); h = honest(host, f"{LISTING}?per_page=100&page=1", "application/json")
    hcls = classify(h)
    rec["requests"].append({"what": "listing1", "host": host, **save(outdir, key, "listing1", h), "class": hcls})
    rec["honest_class"] = hcls
    if stop_here(hcls): rec["stopped"] = f"listing {hcls}"; return rec
    is_woo = hcls in ("Readable", "Empty") or woo_html
    # 4. connector's own request
    if is_woo and n < BUDGET:
        spend(); c = connector(host, f"{LISTING}?per_page=1")
        ccls = classify(c)
        rec["requests"].append({"what": "connector", "host": host, **save(outdir, key, "connector", c), "class": ccls})
        rec["connector_class"] = ccls
        if stop_here(ccls): rec["stopped"] = f"connector {ccls}"; return rec
    # 5. probe
    if hcls not in ("Readable", "Empty") and n < BUDGET:
        subs = set(m.group(1) for m in re.finditer(rb"(?:https?://" + re.escape(host.encode()) + rb")?(/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)/wp-content/", body))
        root_wc = re.search(rb"(?:https?://" + re.escape(host.encode()) + rb"|[\"'(])/wp-content/", body)
        if subs and not root_wc:
            sub = sorted(subs)[0].decode()
            p = f"{sub}{LISTING}?per_page=1"; what = "probe-subpath"
        else:
            p = f"/?rest_route=/wc/store/v1/products&per_page=1"; what = "probe-rest_route"
        if allowed(p):
            spend(); pr = honest(host, p, "application/json"); pcls = classify(pr)
            rec["requests"].append({"what": what, "host": host, "path": p, **save(outdir, key, what, pr), "class": pcls})
            rec["probe"] = {"what": what, "class": pcls}
            if stop_here(pcls): rec["stopped"] = f"probe {pcls}"; return rec
        else:
            rec["probe"] = {"what": what, "class": "robots"}
    # 6. more pages
    if hcls == "Readable":
        total = hget(h, "x-wp-total")
        count1 = len(json.loads(h["body"]))
        need = []
        if total:
            t = int(total[0]) if total[0].strip().isdigit() else None
            if t is not None and 101 <= t <= 200: need = [2]
        elif count1 == 100:
            need = [2, 3]
        for pg in need:
            pp = f"{LISTING}?per_page=100&page={pg}"
            if n >= BUDGET: rec["notes"].append(f"page {pg} unread: budget"); break
            if not allowed(pp): rec["notes"].append(f"page {pg} unread: robots"); break
            spend(); r2 = honest(host, pp, "application/json"); c2 = classify(r2)
            rec["requests"].append({"what": f"listing{pg}", "host": host, **save(outdir, key, f"listing{pg}", r2), "class": c2})
            if stop_here(c2): rec["stopped"] = f"listing{pg} {c2}"; return rec
            if c2 != "Readable" or len(json.loads(r2["body"])) < 100: break
    return rec

def main():
    cands = json.load(open(sys.argv[1])); outdir = sys.argv[3]; os.makedirs(outdir, exist_ok=True)
    seen = set(c["host"].removeprefix("www.") for c in cands)
    done = set(os.path.basename(f)[:-5] for f in os.listdir(outdir) if f.endswith(".json"))
    lim = int(sys.argv[4]) if len(sys.argv) > 4 else None
    k = 0
    for c in cands:
        key = re.sub(r"[^a-z0-9.-]", "_", c["host"])
        if key in done: continue
        if lim is not None and k >= lim: break
        rec = screen(c, outdir, None)
        rec["n_requests"] = len(rec["requests"])
        with open(f"{outdir}/{key}.json", "w") as f: json.dump(rec, f)
        off = rec.get("offsite")
        if off and off.removeprefix("www.") not in seen and not any(x.removeprefix("www.").endswith(regdom(off)) for x in seen):
            seen.add(off.removeprefix("www."))
            cands.insert(cands.index(c) + 1, {**c, "host": off, "via": "redirect from " + c["host"]})
        print(c["q"], c["host"], rec.get("front_class"), rec.get("honest_class"), rec.get("connector_class"), rec.get("stopped", ""), flush=True)
        k += 1
        time.sleep(0.5)

if __name__ == "__main__":
    main()
