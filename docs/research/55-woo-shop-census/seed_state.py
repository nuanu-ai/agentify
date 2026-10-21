"""Evaluate an already screened stratum's records into the state file, in candidate order."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run as R
stratum, cf, outdir, sf = sys.argv[1:5]
state = json.load(open(sf)) if os.path.exists(sf) else {"decisions": {}, "stops": {}}
cands = json.load(open(cf))
recs = {f[:-5] for f in os.listdir(outdir) if f.endswith(".json")}
order = []
for c in cands:
    key = re.sub(r"[^a-z0-9.-]", "_", c["host"])
    if key in recs: order.append(key)
extra = [k for k in recs if k not in order]
for key in order + extra:
    rec = json.load(open(f"{outdir}/{key}.json"))
    d = R.evaluate(outdir, key, rec); d["cand"] = rec["cand"]
    state["decisions"][key] = d
c, countries = R.counts(state)
state["stops"][stratum] = {"counts": c, "countries": countries, "exhausted": True}
json.dump(state, open(sf, "w"))
print(c, countries)
