"""Screen a stratum's candidates in order, applying the note's inclusion and stop rules.
python3 -I run.py <stratum> <candidates.json> <outdir> <state.json>"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen as S
import include as I

def front_html(outdir, key, rec):
    fronts = [r for r in rec["requests"] if r["what"] == "front"]
    if not fronts: return ""
    i = len(fronts) - 1
    p = f"{outdir}/{key}.front{i}.body"
    return open(p, "rb").read().decode("utf-8", "replace") if os.path.exists(p) else ""

def evaluate(outdir, key, rec):
    html = front_html(outdir, key, rec)
    return I.decide(rec, html, None)

def counts(state):
    inc = [v for v in state["decisions"].values() if v.get("included")]
    c = {"ID": 0, "Bali": 0, "IDother": 0, "US": 0, "EU": 0}
    countries = {}
    for v in inc:
        g = v["origin"]["group"]
        if g == "ID":
            c["ID"] += 1
            c["Bali" if v["origin"].get("region") == "Bali" else "IDother"] += 1
        elif g == "US": c["US"] += 1
        elif g == "EU":
            if v.get("country_capped"): continue
            c["EU"] += 1; countries[v["origin"]["country"]] = countries.get(v["origin"]["country"], 0) + 1
    return c, countries

def done(stratum, c):
    if stratum == "B": return c["Bali"] >= 40
    if stratum == "I": return c["IDother"] >= 15 and c["ID"] >= 40
    if stratum == "U": return c["US"] >= 20
    if stratum == "E": return c["EU"] >= 25
    return False

def main():
    stratum, cf, outdir, sf = sys.argv[1:5]
    os.makedirs(outdir, exist_ok=True)
    cands = json.load(open(cf))
    state = json.load(open(sf)) if os.path.exists(sf) else {"decisions": {}, "stops": {}}
    seen = set(c["host"].removeprefix("www.") for c in cands)
    i = 0
    while i < len(cands):
        c, countries = counts(state)
        if done(stratum, c):
            state["stops"][stratum] = {"after": i, "counts": c, "countries": countries}; break
        cand = cands[i]; i += 1
        key = re.sub(r"[^a-z0-9.-]", "_", cand["host"])
        if key in state["decisions"]:
            continue
        if stratum == "E":
            tld = cand["host"].rsplit(".", 1)[-1]
            capped = [k for k, n in countries.items() if n >= 5]
            if any(I.EU[k][0] == tld for k in capped):
                state["decisions"][key] = {"included": False, "reason": "country's share reached (by domain, not requested)", "cand": cand}
                continue
        rec = S.screen(cand, outdir, None)
        rec["n_requests"] = len(rec["requests"])
        with open(f"{outdir}/{key}.json", "w") as f: json.dump(rec, f)
        d = evaluate(outdir, key, rec); d["cand"] = cand
        if d.get("included") and d["origin"]["group"] == "EU" and countries.get(d["origin"]["country"], 0) >= 5:
            d["included"] = False; d["reason"] = "country's share reached"; d["country_capped"] = True
        state["decisions"][key] = d
        off = rec.get("offsite")
        if off and off.removeprefix("www.") not in seen:
            seen.add(off.removeprefix("www."))
            cands.insert(i, {**cand, "host": off, "via": "redirect from " + cand["host"]})
        json.dump(state, open(sf, "w"))
        print(stratum, i, cand["host"], d.get("reason"), (d.get("origin") or {}).get("group"), (d.get("origin") or {}).get("region", (d.get("origin") or {}).get("country", "")), counts(state)[0], flush=True)
        time.sleep(0.5)
    else:
        state["stops"][stratum] = {"after": i, "counts": counts(state)[0], "countries": counts(state)[1], "exhausted": True}
    json.dump(state, open(sf, "w"))
    print("STOP", stratum, state["stops"].get(stratum))

if __name__ == "__main__":
    main()
