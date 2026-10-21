"""Re-apply the inclusion and stop rules to every screened record, stratum by stratum in the note's order.

python3 -I merge.py <rawdir> <out-state.json>
Strata ran partly in parallel on the host; this decides, in order, where each would have stopped,
and marks anything screened beyond that point as discarded.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run as R
import include as I

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
raw = sys.argv[1]; out = sys.argv[2]
plan = [("B", ["B"], "out-B"), ("I", ["I", "IR"], "out-I"), ("U", ["U", "UR"], "out-U"), ("E", ["E", "ER"], "out-E")]
state = {"decisions": {}, "stops": {}, "discarded": [], "unrequested_after_stop": {}}
for stratum, files, od in plan:
    od = f"{raw}/{od}"
    cands = [c for f in files for c in json.load(open(f"{root}/candidates-{f}.json"))]
    # Candidates inserted by an off-site redirect sit right after the candidate that redirected.
    recs = {f[:-5]: json.load(open(f"{od}/{f}")) for f in os.listdir(od) if f.endswith(".json")} if os.path.isdir(od) else {}
    ordered = []
    seen = set()
    for c in cands:
        key = re.sub(r"[^a-z0-9.-]", "_", c["host"])
        ordered.append((key, c)); seen.add(key)
        for k, r in recs.items():
            if k not in seen and r["cand"].get("via") == "redirect from " + c["host"]:
                ordered.append((k, r["cand"])); seen.add(k)
    stopped_at = None
    for idx, (key, c) in enumerate(ordered):
        cnt, countries = R.counts(state)
        if stopped_at is None and R.done(stratum, cnt):
            stopped_at = idx
            state["stops"][stratum] = {"after_candidates": idx, "counts": cnt, "countries": countries}
        if key in state["decisions"]:
            continue
        if stopped_at is not None:
            if key in recs: state["discarded"].append({"stratum": stratum, "key": key})
            continue
        if key not in recs:
            if stratum == "E":
                tld = c["host"].rsplit(".", 1)[-1]
                capped = [k for k, n in countries.items() if n >= 5]
                if any(I.EU[k][0] == tld for k in capped):
                    state["decisions"][key] = {"included": False, "reason": "country's share reached (by domain, not requested)", "cand": c}
                    continue
            state["unrequested_after_stop"].setdefault(stratum, []).append(key)
            continue
        rec = recs[key]
        d = R.evaluate(od, key, rec); d["cand"] = rec["cand"]; d["outdir"] = od
        if d.get("included") and d["origin"]["group"] == "EU" and countries.get(d["origin"]["country"], 0) >= 5:
            d["included"] = False; d["reason"] = "country's share reached"; d["country_capped"] = True
        state["decisions"][key] = d
    if stopped_at is None:
        cnt, countries = R.counts(state)
        state["stops"][stratum] = {"exhausted": True, "counts": cnt, "countries": countries}
json.dump(state, open(out, "w"))
print(json.dumps(state["stops"], indent=1))
print("discarded:", len(state["discarded"]), {k: len(v) for k, v in state["unrequested_after_stop"].items()})
