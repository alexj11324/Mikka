import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const root=resolve(process.cwd()), artifact=resolve(root,'.issue1512/artifacts')
await mkdir(artifact,{recursive:true})
const manifest=JSON.parse(await readFile('.issue1512/manifest.json','utf8'))
const hash=(b,algorithm='sha256')=>createHash(algorithm).update(b).digest('hex')
const inputBytes=await readFile('.issue1512/input.json')
assert.equal(hash(inputBytes),manifest.inputSha256)
for(const f of manifest.files){
  assert.ok(!f.path.startsWith('/')&&!f.path.split('/').includes('..'))
  const b=await readFile(f.path)
  assert.equal(b.length,f.bytes);assert.equal(hash(b),f.sha256)
  assert.equal(hash(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b]),'sha1'),f.sha)
}
const input=JSON.parse(inputBytes)
const startedAt=new Date().toISOString()
const ts=input.toolchain.typescript
const response=await fetch(ts.tarball, { signal: AbortSignal.timeout(30000) })
assert.equal(response.status,200)
const tarball=Buffer.from(await response.arrayBuffer())
assert.equal('sha512-'+createHash('sha512').update(tarball).digest('base64'),ts.integrity)
await mkdir('node_modules/typescript',{recursive:true})
await writeFile('.issue1512/typescript.tgz',tarball)
const unpack=spawnSync('tar',['-xzf','.issue1512/typescript.tgz','--strip-components=1','-C','node_modules/typescript'],{encoding:'utf8',timeout:30000})
assert.equal(unpack.status,0)
assert.equal(JSON.parse(await readFile('node_modules/typescript/package.json','utf8')).version,ts.version)
const commands=[]
async function run(name,args){
 const begin=new Date().toISOString()
 const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024})
 await writeFile(artifact+'/'+name+'.stdout.log',result.stdout??'')
 await writeFile(artifact+'/'+name+'.stderr.log',result.stderr??'')
 const entry={name,args,startedAt:begin,finishedAt:new Date().toISOString(),exitCode:result.status,signal:result.signal,errorCode:result.error?.code??null,stdoutBytes:Buffer.byteLength(result.stdout??''),stdoutSha256:hash(result.stdout??''),stderrBytes:Buffer.byteLength(result.stderr??''),stderrSha256:hash(result.stderr??'')}
 commands.push(entry);return result
}
const gen=await run('canonical',['apps/api/scripts/generate-routes.mjs'])
const test=await run('template-merge-tests',['--test','--test-reporter=tap','scripts/e2b/validate-template-subscriptions.test.mjs'])
const outputs=[]
if(gen.status===0)for(const p of input.outputs){
 const b=await readFile(p);outputs.push({path:p,bytes:b.length,sha256:hash(b),gitBlob:hash(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b]),'sha1')})
}
const result={schema:'issue1512.maincc-execution-receipt.v1',startedAt,finishedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.versions.node,typescript:ts.version,source:manifest.source,inputSha256:manifest.inputSha256,inputGitBlob:manifest.inputGitBlob,verifiedSourceFiles:manifest.files.length,sourceHashMismatches:0,commands,outputs,canonicalSummary:gen.status===0?JSON.parse(gen.stdout):null,validation:'Real Node execution of the frozen canonical generator and merged template gate tests. No PostgreSQL, product server, production credentials or model configured.',status:gen.status===0&&test.status===0?'passed':'failed'}
await writeFile(artifact+'/receipt.json',JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result))
process.exitCode=result.status==='passed'?0:1
