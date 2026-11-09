import pathlib,json,hashlib,subprocess,os,time,datetime,signal
r=pathlib.Path('/vercel/mikka-1505-factory-id-semantics');o=pathlib.Path('/vercel/ops-1505/mcp-context-traceparent-candidate');a=o/'fullcheck-addendum';a.mkdir(exist_ok=True)
pnpm='/vercel/ops-1505/source-checks-7c014579/bin/pnpm';env=os.environ.copy();env['PATH']=str(pathlib.Path(pnpm).parent)+':'+env.get('PATH','');env['NODE_OPTIONS']='--max-old-space-size=3072';env['MIKKA_EDITION']='cloud';env['CI']='true'
def git(*args):return subprocess.check_output(['git',*args],cwd=r,text=True).strip()
assert git('rev-parse','HEAD')=='d6835377c820db7d1d4e704afed2c58cdfaec789'
assert not git('status','--porcelain','--untracked-files=no')
lock=hashlib.sha256((r/'pnpm-lock.yaml').read_bytes()).hexdigest();assert lock=='c45db74b59cc73d6c5fab0858f6656ee7bf5ec1bf99f5ac5c0a94c8a1885a363'
js="""import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {RUN_DECISION_CATALOGUE} from './lib/project-map/mcp-tool.ts';import {runDecisionCatalogueSchema} from '@mikka/protocol';const a=JSON.stringify(RUN_DECISION_CATALOGUE),b=JSON.stringify(runDecisionCatalogueSchema.parse(RUN_DECISION_CATALOGUE));assert.equal(b,a);console.log(JSON.stringify({sameSerializedBytes:true,bytes:Buffer.byteLength(a),exportSha256:createHash('sha256').update(a).digest('hex'),parsedSha256:createHash('sha256').update(b).digest('hex'),source:'lib/project-map/mcp-tool.ts',sourceBlob:'REPLACE_BLOB',validation:'Existing protocol schema parses the actual exported claim catalogue without changing serialized bytes.'}));"""
js=js.replace('REPLACE_BLOB',git('rev-parse','HEAD:lib/project-map/mcp-tool.ts'))
p=subprocess.run(['node','--import','tsx','--input-type=module','-e',js],cwd=r,env=env,capture_output=True,timeout=30)
(o/'catalogue-serialization.stderr').write_bytes(p.stderr)
assert p.returncode==0,p.stderr.decode()
proof=json.loads(p.stdout);(o/'catalogue-serialization-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
started=datetime.datetime.now(datetime.timezone.utc).isoformat();script=json.loads((r/'package.json').read_text())['scripts']['check']
cache=[]
for rel in ['node_modules','node_modules/.vite','packages/daemon/node_modules','packages/daemon/node_modules/.vite']:
 path=r/rel;assert str(path.resolve()).startswith(str(r)+'/');cache.append({'path':rel,'realpath':str(path.resolve()),'symlink':path.is_symlink()})
identity={'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'lockSha256':lock,'trackedCleanBefore':True,'command':[pnpm,'check'],'cwd':str(r),'startedAt':started,'environmentOverrides':{'MIKKA_EDITION':'cloud','CI':'true','NODE_OPTIONS':env['NODE_OPTIONS'],'PATHFirst':str(pathlib.Path(pnpm).parent)},'packageCheckScript':script,'orderedCommands':script.split(' && '),'cachePaths':cache,'timeoutSeconds':900}
(a/'input.json').write_text(json.dumps(identity,indent=2)+'\n')
t=time.monotonic();timedOut=False
with (a/'check.log').open('wb') as log:
 child=subprocess.Popen([pnpm,'check'],cwd=r,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 (a/'process.json').write_text(json.dumps({'pid':child.pid,'startedAt':started,'command':[pnpm,'check']},indent=2)+'\n')
 print(json.dumps({'started':True,'pid':child.pid,'head':identity['head'],'catalogueSameBytes':True}),flush=True)
 try:exitCode=child.wait(timeout=900)
 except subprocess.TimeoutExpired:
  timedOut=True;os.killpg(child.pid,signal.SIGTERM)
  try:exitCode=child.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);exitCode=child.wait()
result={'head':identity['head'],'tree':identity['tree'],'lockSha256Before':lock,'lockSha256After':hashlib.sha256((r/'pnpm-lock.yaml').read_bytes()).hexdigest(),'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'durationSeconds':round(time.monotonic()-t,3),'exitCode':exitCode,'timedOut':timedOut,'trackedCleanAfter':not git('status','--porcelain','--untracked-files=no'),'logBytes':(a/'check.log').stat().st_size,'logSha256':hashlib.sha256((a/'check.log').read_bytes()).hexdigest()}
(a/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'finished':True,'exitCode':exitCode,'seconds':result['durationSeconds'],'timedOut':timedOut}),flush=True)
