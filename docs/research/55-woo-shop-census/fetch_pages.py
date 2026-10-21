"""Fetch each page about merchants once (from the Mac) and extract its outbound links in document order."""
import json, os, re, subprocess, sys, time, hashlib, html
from urllib.parse import urlsplit, urljoin
sys.path.insert(0, os.path.dirname(__file__))
from common import regdom, excluded, UA_HONEST
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
res=json.load(open(f"{root}/results.json"))
pages_dir=f"{root}/pages"; os.makedirs(pages_dir, exist_ok=True)
qs=set(int(x) for x in sys.argv[1].split(",")) if len(sys.argv)>1 else None
meta_path=f"{root}/pages.json"
meta=json.load(open(meta_path)) if os.path.exists(meta_path) else {}
for r in res:
    if r["kind"]!="A" or (qs and r["q"] not in qs): continue
    u=r["url"]
    if u in meta: continue
    fn=f"{pages_dir}/{hashlib.sha1(u.encode()).hexdigest()[:16]}.html"
    p=subprocess.run(["curl","-sS","-L","--max-redirs","5","-m","25","-A",UA_HONEST,"-o",fn,"-w","%{http_code} %{url_effective}",u],capture_output=True,text=True)
    code,_,eff=p.stdout.partition(" ")
    body=open(fn,errors="replace").read() if os.path.exists(fn) else ""
    links=[]
    for m in re.finditer(r'<a\b[^>]*?\shref\s*=\s*["\']([^"\']+)["\']', body, re.I):
        h=html.unescape(m.group(1)).strip()
        if not h.lower().startswith(("http://","https://","//")): continue
        full=urljoin(eff or u, h)
        links.append(full)
    meta[u]={"status":code,"final":eff,"file":os.path.basename(fn),"links":links,"err":p.stderr.strip()[:200]}
    print(r["q"],r["rank"],code,len(links),u[:90],flush=True)
    json.dump(meta,open(meta_path,"w"))
    time.sleep(1)
