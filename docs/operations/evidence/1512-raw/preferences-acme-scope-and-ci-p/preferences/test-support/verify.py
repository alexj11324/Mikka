import pathlib, subprocess, json, hashlib, difflib, sys
root=pathlib.Path.cwd()
out=root/'evidence'
out.mkdir(exist_ok=True)
results={}
def run(label,args):
    p=subprocess.run(args, cwd=root, capture_output=True, timeout=60)
    (out/(label+'.stdout')).write_bytes(p.stdout)
    (out/(label+'.stderr')).write_bytes(p.stderr)
    results[label]={'exitCode':p.returncode,'stdoutBytes':len(p.stdout),'stderrBytes':len(p.stderr)}
    return p.returncode
target=root/'lib/preferences.ts'
final=target.read_bytes()
try:
    target.write_bytes((root/'baseline/lib/preferences.ts').read_bytes())
    run('old-red',['node','--import','tsx','--import','./tests/support/server-only.mjs','--test','--test-reporter=tap','./isolated.test.ts'])
finally:
    target.write_bytes(final)
run('new-green',['node','--import','tsx','--import','./tests/support/server-only.mjs','--test','--test-reporter=tap','./isolated.test.ts'])
run('lint',['./node_modules/.bin/oxlint','lib/preferences.ts','tests/settings-preferences.db.test.ts','--deny-warnings'])
run('source-whitespace',['git','diff','--no-index','--check','baseline/lib/preferences.ts','lib/preferences.ts'])
run('test-whitespace',['git','diff','--no-index','--check','baseline/tests/settings-preferences.db.test.ts','tests/settings-preferences.db.test.ts'])
for path in ['lib/preferences.ts','tests/settings-preferences.db.test.ts']:
    a=(root/'baseline'/path).read_text().splitlines(keepends=True)
    b=(root/path).read_text().splitlines(keepends=True)
    (out/(path.replace('/','_')+'.patch')).write_text(''.join(difflib.unified_diff(a,b,fromfile='a/'+path,tofile='b/'+path)))
versions={'node':subprocess.check_output(['node','--version'],text=True).strip()}
for name in ['@electric-sql/pglite','drizzle-orm','zod','tsx','oxlint']:
    versions[name]=json.loads((root/'node_modules'/name/'package.json').read_text())['version']
summary={'versions':versions,'results':results,'scope':'actual-reader-and-schema-with-isolated-pglite-adapter','externalServices':False}
(out/'validation.json').write_text(json.dumps(summary,indent=2)+'\n')
items=[]
for path in sorted(out.iterdir()):
    b=path.read_bytes()
    items.append({'path':str(path.relative_to(root)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlob':hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()})
(root/'artifact-index.json').write_text(json.dumps(items,indent=2)+'\n')
print(json.dumps(summary,separators=(',',':')))
sys.exit(0 if results['old-red']['exitCode']==1 and results['new-green']['exitCode']==0 and results['lint']['exitCode']==0 and all(results[k]['exitCode'] in [0,1] and results[k]['stdoutBytes']==0 and results[k]['stderrBytes']==0 for k in ['source-whitespace','test-whitespace']) else 1)
