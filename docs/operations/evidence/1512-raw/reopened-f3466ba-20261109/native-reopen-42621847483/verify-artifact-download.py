import os,json,pathlib,urllib.request,urllib.parse,hashlib,zipfile,stat
R=pathlib.Path('/vercel/sandbox/native-reopen-42621847483');R.mkdir(parents=True,exist_ok=True)
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  h=(urllib.parse.urlparse(newurl).hostname or '').lower()
  if not (h=='chatgpt.com' or h.endswith('.blob.core.windows.net') or h.endswith('.amazonaws.com') or h.endswith('.oaiusercontent.com')):raise RuntimeError('redirect_host_not_allowed')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
opener=urllib.request.build_opener(Redirect);manifest=[]
for spec in json.loads(os.environ['FORENSIC_SPECS']):
 u=os.environ['FORENSIC_URL_'+spec['kind'].upper()];host=(urllib.parse.urlparse(u).hostname or '').lower()
 assert host=='chatgpt.com' or host.endswith('.blob.core.windows.net') or host.endswith('.amazonaws.com') or host.endswith('.oaiusercontent.com')
 p=R/spec['filename'];h=hashlib.sha256();size=0
 try:
  with opener.open(u,timeout=45) as src,p.open('xb') as out:
   while chunk:=src.read(1024*1024):out.write(chunk);h.update(chunk);size+=len(chunk)
 except Exception as e:
  print(json.dumps({'stage':'materialize','kind':spec['kind'],'errorType':type(e).__name__,'status':getattr(e,'code',None)}));raise SystemExit(1)
 assert size==spec['bytes'] and h.hexdigest()==spec['sha256'],'ZIP_BYTES_OR_SHA'
 d=R/p.stem;d.mkdir()
 with zipfile.ZipFile(p) as z:
  assert z.testzip() is None
  for zi in z.infolist():
   path=pathlib.PurePosixPath(zi.filename)
   assert not path.is_absolute() and '..' not in path.parts and '\\' not in zi.filename and not stat.S_ISLNK(zi.external_attr>>16)
  z.extractall(d)
 files=[]
 for f in sorted(d.rglob('*')):
  if f.is_file():
   b=f.read_bytes();files.append({'path':str(f.relative_to(R)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlobSha1':hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()})
 manifest.append({**spec,'actualBytes':size,'actualSha256':h.hexdigest(),'zipIntegrity':'passed','fileCount':len(files),'files':files})
(R/'original-files-manifest.safe.json').write_text(json.dumps(manifest,indent=2)+'\n')
L=json.loads((R/'native-reopen-42621847483-original/lifecycle.json').read_bytes());W=L['queryCounts']['windows']
summary={'revision':L['revision'],'result':L['result'],'windows':{name:{'status':w['status'],'total':w.get('total',{}).get('queryCalls'),'segments':[{'phase':s['phase'],'queryCalls':s['queryCalls']} for s in w.get('segments',[])],'pair':w.get('pair')} for name,w in W.items()},'zipIntegrity':'both exact API bytes/SHA and testzip passed','files':[{ 'kind':m['kind'],'count':m['fileCount']} for m in manifest]}
(R/'first-read.safe.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
