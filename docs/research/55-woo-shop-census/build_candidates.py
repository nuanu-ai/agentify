"""Turn ordered search results and fetched pages into an ordered candidate list for one stratum."""
import json, os, re, sys
from urllib.parse import urlsplit
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import regdom, excluded
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Link shorteners and affiliate trackers lead to no merchant by their own address.
TRACKERS=re.compile(r"(^|\.)(bit\.ly|rebrand\.ly|prf\.hn|pxf\.io|tp\.media|linksynergy\.com|tkqlhce\.com|linktr\.ee|s\.id|wa\.link|cfjump\.com|mkos\.app|tsel\.id|shp\.ee|lnk\.to|bit\.do|tinyurl\.com|ow\.ly|buff\.ly|clickcease\.com|anrdoezrs\.net|jdoqocy\.com|dpbolvw\.net|awin1\.com|shareasale\.com|go2cloud\.org|impact\.com|sjv\.io|skimresources\.com|amzn\.to|cloudfront\.net|amazonaws\.com|issuu\.com|beehiiv\.com|substack\.com|podbean\.com|mixcloud\.com|flipboard\.com|finalsite\.net|webpublisherpro\.com|openai\.com|microsoft\.com)$", re.I)
stratum, qlo, qhi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
res=[r for r in json.load(open(f"{root}/results.json")) if qlo<=r["q"]<=qhi]
meta=json.load(open(f"{root}/pages.json"))
def canonical(u,m):
    try:
        body=open(f"{root}/pages/{m['file']}",errors="replace").read()
    except OSError:
        body=""
    c=re.search(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)', body, re.I) or re.search(r'<link[^>]+href=["\']([^"\']+)["\'][^>]*rel=["\']canonical', body, re.I)
    return (c.group(1) if c else (m["final"] or u)).split("?")[0].rstrip("/").replace("/amp","")
# Sister sites: domains linked from every distinct page of a publisher that has two or more.
by_pub={}
for u,m in meta.items():
    if not m["links"]: continue
    p=regdom(urlsplit(m["final"] or u).hostname)
    doms=set(regdom(urlsplit(l).hostname) for l in m["links"] if urlsplit(l).hostname)
    by_pub.setdefault(p,{})[canonical(u,m)]=doms
sister={p:(set.intersection(*pages.values()) if len(pages)>=2 else set()) for p,pages in by_pub.items()}
prior=[a for a in sys.argv[4:]]
seen=set(c["host"].removeprefix("www.") for f in prior for c in json.load(open(f"{root}/candidates-{f}.json"))); out=[]; dropped={"excluded_kind":0,"tracker":0,"publisher_own":0,"sister":0,"duplicate":0}
def add(host,r,via):
    key=(host or "").lower().removeprefix("www.")
    if key in seen: dropped["duplicate"]+=1; return
    seen.add(key); out.append({"host":host.lower(),"stratum":stratum,"q":r["q"],"rank":r["rank"],"via":via})
for r in res:
    if r["kind"]=="M": add(r["host"],r,"result"); continue
    if r["kind"]!="A": continue
    m=meta.get(r["url"])
    if not m: continue
    p=regdom(urlsplit(m["final"] or r["url"]).hostname)
    for l in m["links"]:
        h=urlsplit(l).hostname
        if not h: continue
        h=h.lower()
        if excluded(h): dropped["excluded_kind"]+=1; continue
        if TRACKERS.search(h): dropped["tracker"]+=1; continue
        if regdom(h)==p: dropped["publisher_own"]+=1; continue
        if regdom(h) in sister.get(p,set()): dropped["sister"]+=1; continue
        add(h,r,r["url"])
json.dump(out,open(f"{root}/candidates-{stratum}.json","w"),indent=0)
print(len(out),dropped)
