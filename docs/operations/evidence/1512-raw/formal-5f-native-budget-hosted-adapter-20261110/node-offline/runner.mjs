import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const dir=path.dirname(new URL(import.meta.url).pathname)
const sh=b=>crypto.createHash('sha256').update(b).digest('hex')
const gb=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex')
const inputBytes=fs.readFileSync(path.join(dir,'input.json'))
assert.equal(sh(inputBytes),'131b14bf44877d9a2a0a289b1bd395adc9d1d9b3be3fda07b716c9355542df57')
assert.equal(gb(inputBytes),'1bbb9f015719e643687c2a931eb7e7ffb1da7d98')
const input=JSON.parse(inputBytes)
assert.equal(Number(process.versions.node.split('.')[0]),24)
const green=path.join(dir,'green'),red=path.join(dir,'red'),out=path.join(dir,'out')
for(const p of [green,red,out])fs.mkdirSync(p,{recursive:true,mode:0o700})
for(const f of input.files){
 assert.ok(!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'))
 const b=Buffer.from(f.content);assert.equal(b.length,f.bytes);assert.equal(sh(b),f.sha256);assert.equal(gb(b),f.sha)
 const dest=path.join(green,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,b,{mode:0o600})
}
fs.cpSync(green,red,{recursive:true})
const old=Buffer.from(input.oldDriver.content)
assert.equal(old.length,input.oldDriver.bytes);assert.equal(sh(old),input.oldDriver.sha256);assert.equal(gb(old),input.oldDriver.sha)
fs.writeFileSync(path.join(red,input.oldDriver.path),old,{mode:0o600})
const env=Object.fromEntries(['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]))
const jobs=[
 {name:'browser_red_old_driver_new_tests',cwd:red,tests:['scripts/acceptance/run-observability-browser.test.mjs']},
 {name:'browser_and_core_green',cwd:green,tests:['scripts/acceptance/run-observability-browser.test.mjs','scripts/acceptance/run-observability.test.mjs']},
 {name:'production_dispatch_controller',cwd:green,tests:['scripts/ops/issue1512-production-dispatch.test.mjs']}
]
const results=[]
for(const job of jobs){
 const args=['--test','--test-reporter=tap',...job.tests],startedAt=new Date().toISOString()
 const r=spawnSync(process.execPath,args,{cwd:job.cwd,env,timeout:120000,maxBuffer:8*1024*1024})
 const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0)
 fs.writeFileSync(path.join(out,job.name+'.stdout'),stdout,{mode:0o600});fs.writeFileSync(path.join(out,job.name+'.stderr'),stderr,{mode:0o600})
 results.push({name:job.name,command:[process.execPath,...args],startedAt,finishedAt:new Date().toISOString(),exitCode:r.status,signal:r.signal,errorCode:r.error?.code??null,
 stdout:{bytes:stdout.length,sha256:sh(stdout),gitBlob:gb(stdout),base64:stdout.toString('base64')},
 stderr:{bytes:stderr.length,sha256:sh(stderr),gitBlob:gb(stderr),base64:stderr.toString('base64')}})
}
const bundle={schema:'mikka.issue1512.offline-node-results.v1',inputBlob:gb(inputBytes),inputSha256:sh(inputBytes),runnerSha256:sh(fs.readFileSync(new URL(import.meta.url))),node:process.version,platform:process.platform,arch:process.arch,envKeys:Object.keys(env),sourceFiles:input.files.map(({content,...f})=>f),oldDriver:{sha:input.oldDriver.sha,sha256:input.oldDriver.sha256},results}
const raw=Buffer.from(JSON.stringify(bundle)+'\n'),gz=zlib.gzipSync(raw,{level:9})
fs.writeFileSync(path.join(out,'bundle.json'),raw,{mode:0o600});fs.writeFileSync(path.join(out,'bundle.json.gz'),gz,{mode:0o600})
const parts=[]
for(let at=0,i=0;at<gz.length;at+=1200,i++){const b=gz.subarray(at,at+1200),name='part-'+String(i).padStart(3,'0')+'.bin';fs.writeFileSync(path.join(out,name),b,{mode:0o600});parts.push({name,bytes:b.length,sha256:sh(b)})}
const receipt={inputBlob:gb(inputBytes),node:process.version,results:results.map(({stdout,stderr,...r})=>({...r,stdoutBytes:stdout.bytes,stderrBytes:stderr.bytes})),bundle:{bytes:raw.length,sha256:sh(raw),gitBlob:gb(raw),gzipBytes:gz.length,gzipSha256:sh(gz),parts}}
fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt)+'\n',{mode:0o600})
console.log(JSON.stringify({inputBlob:receipt.inputBlob,node:receipt.node,results:receipt.results.map(r=>({name:r.name,exitCode:r.exitCode,stdoutBytes:r.stdoutBytes,stderrBytes:r.stderrBytes})),bundle:{bytes:raw.length,sha256:sh(raw),gitBlob:gb(raw),gzipBytes:gz.length,gzipSha256:sh(gz),parts:parts.length}}))
