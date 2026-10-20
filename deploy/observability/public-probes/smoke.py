#!/usr/bin/env python3
"""Check real public-probe content rules and remote-write labels in an internal Docker network.

Uses disposable HTTP fixtures and synthetic credentials, never a public site or
live receiver. Requires Docker and the two images already cached locally.
"""
import json,pathlib,subprocess,tempfile,time,uuid,struct
root=pathlib.Path(__file__).resolve().parent
image='grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839';name='agentify-probe-smoke-'+uuid.uuid4().hex[:8];containers=[]
def docker(*args):return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.STDOUT,timeout=30)
def varint(data,offset):
 value=0;shift=0
 while True:
  byte=data[offset];offset+=1;value|=(byte&127)<<shift
  if byte<128:return value,offset
  shift+=7

def unsnappy(data):
 length,i=varint(data,0);out=bytearray()
 while i<len(data):
  tag=data[i];i+=1;kind=tag&3
  if kind==0:
   n=tag>>2
   if n<60:n+=1
   else:
    k=n-59;n=int.from_bytes(data[i:i+k],'little')+1;i+=k
   out.extend(data[i:i+n]);i+=n
  else:
   if kind==1:n=4+((tag>>2)&7);offset=((tag&224)<<3)|data[i];i+=1
   elif kind==2:n=1+(tag>>2);offset=int.from_bytes(data[i:i+2],'little');i+=2
   else:n=1+(tag>>2);offset=int.from_bytes(data[i:i+4],'little');i+=4
   for _ in range(n):out.append(out[-offset])
 assert len(out)==length
 return out

def fields(data):
 i=0
 while i<len(data):
  tag,i=varint(data,i);kind=tag&7
  if kind==2:n,i=varint(data,i);v=data[i:i+n];i+=n
  elif kind==0:v,i=varint(data,i)
  elif kind==1:v=data[i:i+8];i+=8
  elif kind==5:v=data[i:i+4];i+=4
  else:raise ValueError(kind)
  yield tag>>3,v

def samples(d):
 result={}
 for p in sorted(d.glob('*.snappy')):
  for n,series in fields(unsnappy(p.read_bytes())):
   if n!=1:continue
   labels={};points=[]
   for num,data in fields(series):
    if num==1:
     label=dict(fields(data));labels[bytes(label[1]).decode()]=bytes(label[2]).decode()
    elif num==2:
     point=dict(fields(data));points.append((point[2],struct.unpack('<d',point.get(1,bytes(8)))[0]))
   if labels.get('__name__')=='probe_success':
    assert labels.get('app')=='agentify' and labels.get('environment')=='production' and labels.get('job')=='agentify/public' and labels.get('vantage')=='joglo' and labels.get('instance')=='joglo',labels
    for ts,value in points:
     key=labels['component']
     if key not in result or result[key][0]<ts:result[key]=(ts,value)
 return result
try:
 docker('network','create','--internal',name)
 with tempfile.TemporaryDirectory(prefix='agentify-probe-fixture-') as td:
  d=pathlib.Path(td);d.chmod(0o777);(d/'mode').write_text('good')
  (d/'server.py').write_text('''from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
import uuid
class H(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  mode=Path('/out/mode').read_text();good=mode=='good'
  if self.headers.get('User-Agent')!='Agentify-Observability-Probe/1.0':
   self.send_response(400);self.end_headers();return
  if mode=='wrong_html':
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<html><h1>Service unavailable</h1></html>');return
  if mode=='wrong_surface':
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<html><input name="email"><form action="/dashboard/sign-in"></form></html>' if self.path=='/' else b'<html><input name="url"></html>');return
  if not good and self.path=='/dashboard/sign-in':
   self.send_response(302);self.send_header('location','/');self.end_headers();return
  self.send_response(200);self.send_header('Content-Type','application/json' if self.path=='/x402/catalog' else 'text/html');self.end_headers()
  self.wfile.write((b'{"items":[]}' if good else b'{"wrong":[]}') if self.path=='/x402/catalog' else ((b'<html><input name="email"><form action="/dashboard/sign-in"></form></html>' if self.path=='/dashboard/sign-in' else b'<html><input name="url"></html>') if good else b'upstream unavailable'))
 def do_POST(self):
  dest=Path('/out/'+str(__import__('time').time_ns())+'.snappy');partial=dest.with_suffix('.partial');partial.write_bytes(self.rfile.read(int(self.headers['Content-Length'])));partial.rename(dest)
  self.send_response(204);self.end_headers()
HTTPServer(('0.0.0.0',8080),H).serve_forever()
''')
  receiver=name+'-receiver';containers.append(receiver)
  docker('run','--pull=never','-d','--name',receiver,'--network',name,'--network-alias','receiver','-v',str(d)+':/out','python:3.12-slim-bookworm','python','/out/server.py')
  config=(root/'config.alloy').read_text().replace('"https://agentify.ad"','"http://receiver:8080"').replace('scrape_interval = "30s"','scrape_interval = "1s"').replace('scrape_timeout = "10s"','scrape_timeout = "1s"')
  start=config.index('    tls_config {');end=config.index('    }',start)+5;config=config[:start]+config[end:]
  (d/'config.alloy').write_text(config)
  collector=name+'-collector';containers.append(collector)
  docker('run','--pull=never','-d','--name',collector,'--network',name,'-v',str(d/'config.alloy')+':/etc/alloy/config.alloy:ro','-v',str(root/'blackbox.yaml')+':/etc/alloy/blackbox.yaml:ro','-e','AGENTIFY_CHANNEL=production','-e','OBSERVABILITY_METRICS_URL=http://receiver:8080/metrics','-e','OBSERVABILITY_USERNAME=synthetic','-e','OBSERVABILITY_PASSWORD=synthetic',image,'run','/etc/alloy/config.alloy')
  observations=[]
  for mode,expected in [('good',1),('wrong_html',0),('wrong_surface',0),('bad',0)]:
   (d/'mode').write_text(mode);phase_started=int(time.time()*1000);deadline=time.monotonic()+24
   while time.monotonic()<deadline:
    current=samples(d)
    if set(current)=={'scanner_page','catalog','sign_in_page'} and all(v[0]>phase_started for v in current.values()):
     assert all(v[1]==expected for v in current.values()),(mode,current)
     break
    time.sleep(.3)
   else:raise AssertionError((mode,current))
   observations.append({'fixture':mode,'probe_success':{k:v[1] for k,v in current.items()}})
  print(json.dumps({'remote_write_readback':'passed','positive_and_negative_content_checks':observations,'redirect_not_followed':True,'production_labels_verified':True}))
except Exception:
 if containers:print(docker('logs',containers[-1])[-2000:])
 raise
finally:
 for container in reversed(containers):subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','network','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
