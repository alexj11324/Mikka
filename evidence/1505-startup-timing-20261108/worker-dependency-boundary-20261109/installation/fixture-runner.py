import os,pathlib,json,subprocess,tarfile,io,gzip,hashlib,shutil,time
OUT=pathlib.Path('/vercel/ops-1505/worker-dependency-boundary-024')
OUT.mkdir(parents=True,exist_ok=True)
BASE=OUT/'fixture-source'
BASE.mkdir()
pnpm=pathlib.Path('/vercel/.cache/node/corepack/v1/pnpm/10.34.3/bin/pnpm.cjs')
assert pnpm.is_file(),str(pnpm)
def write(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,indent=2)+'\n')
def tar(name,label):
    dest=BASE/'tarballs'/f'{name}.tgz';dest.parent.mkdir(exist_ok=True)
    payload={'name':name,'version':'1.0.0','scripts':{'postinstall':'node postinstall.cjs'},'main':'index.cjs'}
    with tarfile.open(dest,'w:gz') as t:
        for n,b in {'package.json':json.dumps(payload).encode(),'postinstall.cjs':("require('fs').appendFileSync(process.env.FIXTURE_RECEIPT, '"+label+"\\n')").encode(),'index.cjs':('module.exports = '+json.dumps(label)).encode()}.items():
            e=tarfile.TarInfo('package/'+n);e.size=len(b);e.mode=0o644;e.mtime=0;t.addfile(e,io.BytesIO(b))
for name,label in [('root-only','root-only'),('runtime-only','runtime-only'),('build-only','build-only')]:tar(name,label)
write(BASE/'package.json',{'name':'fixture-root','private':True,'packageManager':'pnpm@10.34.3','dependencies':{'root-only':'file:tarballs/root-only.tgz'}})
(BASE/'pnpm-workspace.yaml').write_text("packages:\n  - packages/*\nallowBuilds:\n  root-only: true\n  runtime-only: true\n  build-only: true\n")
write(BASE/'packages/config/package.json',{'name':'@mikka/config','version':'1.0.0','private':True})
write(BASE/'packages/protocol/package.json',{'name':'@mikka/protocol','version':'1.0.0','private':True,'dependencies':{'runtime-only':'file:../../tarballs/runtime-only.tgz'},'devDependencies':{'@mikka/config':'workspace:*'}})
write(BASE/'packages/daemon/package.json',{'name':'@mikka/daemon','version':'1.0.0','private':True,'dependencies':{'@mikka/protocol':'workspace:*'},'devDependencies':{'@mikka/config':'workspace:*','build-only':'file:../../tarballs/build-only.tgz'}})
def run(case,args,label):
    receipt=case/'lifecycle.txt'
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(OUT/'fixture-home'),'CI':'true','FIXTURE_RECEIPT':str(receipt)}
    start=time.monotonic()
    p=subprocess.run(['/usr/local/bin/node',str(pnpm),*args],cwd=case,env=env,capture_output=True,timeout=30)
    (OUT/(label+'.stdout.log')).write_bytes(p.stdout);(OUT/(label+'.stderr.log')).write_bytes(p.stderr)
    return {'label':label,'exit':p.returncode,'elapsedMs':round((time.monotonic()-start)*1000),'stdoutBytes':len(p.stdout),'stderrBytes':len(p.stderr)}
results=[run(BASE,['install','--lockfile-only','--offline','--store-dir',str(OUT/'seed-store')],'lockfile')]
assert results[-1]['exit']==0,results[-1]
lock=(BASE/'pnpm-lock.yaml').read_bytes()
for name in ['baseline-filter','candidate-nonrecursive']:
    case=OUT/name;shutil.copytree(BASE,case)
    if name=='baseline-filter':
        rows=[run(case,['install','--filter','@mikka/daemon...','--frozen-lockfile','--offline','--store-dir',str(case/'.store')],name)]
    else:
        rows=[]
        for package in ['config','protocol','daemon']:
            rows.append(run(case,['--dir','packages/'+package,'install','--config.recursive-install=false','--frozen-lockfile','--offline','--store-dir',str(case/'.store')],name+'-'+package))
            if rows[-1]['exit']:break
    results+=rows
    summary={'case':name,'allCommandsSucceeded':all(x['exit']==0 for x in rows),'rootDependencyLinked':(case/'node_modules/root-only').exists(),
             'lifecycle':(case/'lifecycle.txt').read_text().splitlines() if (case/'lifecycle.txt').exists() else [],
             'daemonDevDependencyLinked':(case/'packages/daemon/node_modules/build-only').exists(),
             'protocolRuntimeDependencyLinked':(case/'packages/protocol/node_modules/runtime-only').exists(),
             'lockUnchanged':(case/'pnpm-lock.yaml').read_bytes()==lock}
    (OUT/(name+'.result.json')).write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps(summary),flush=True)
(OUT/'fixture-command-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'commands':results,'pnpm':str(pnpm),'baseLockSha256':hashlib.sha256(lock).hexdigest(),'done':True}),flush=True)
