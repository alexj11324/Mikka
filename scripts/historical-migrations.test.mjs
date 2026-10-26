import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync,readdirSync } from 'node:fs'
import { historicalImports,verifyHistoricalSources,currentMainMigrations } from './historical-migrations.mjs'
import { checkMigrations } from './check-migrations.mjs'
const files=()=>readdirSync('drizzle').filter(n=>n.endsWith('.sql')).map(name=>({name,content:readFileSync('drizzle/'+name)}))
const textFiles=()=>files().map(f=>({...f,content:f.content.toString()}))
const manifest=readFileSync('drizzle/historical-imports.json')
test('exact reviewed manifest, all 32 byte hashes and source provenance',()=>{
 const entries=historicalImports(files());assert.equal(entries.length,32)
 verifyHistoricalSources(entries,(_sha,path)=>readFileSync(path))
 assert.equal(new Set(entries.map(e=>e.sourceCommit)).size,2)
})
test('manifest bytes cannot add/remove/relabel an import',()=>{
 for(const change of [m=>m.entries.pop(),m=>m.entries.push(m.entries[0]),m=>m.entries[0].sourceCommit='0'.repeat(40),m=>m.entries[0].path='drizzle/20261025235959_other.sql',m=>m.entries[0].sha256='0'.repeat(64)]){
  const m=JSON.parse(manifest);change(m);assert.throws(()=>historicalImports(files(),Buffer.from(JSON.stringify(m))),/manifest digest/)
 }
})
test('missing/duplicate/content mutation fails even after imports enter main',()=>{
 const entry=historicalImports(files())[0],name=entry.path.slice(8)
 assert.throws(()=>historicalImports(files().filter(f=>f.name!==name)),/missing, duplicate or changed/)
 assert.throws(()=>historicalImports([...files(),files().find(f=>f.name===name)]),/missing, duplicate or changed/)
 const changed=files().map(f=>f.name===name?{...f,content:Buffer.concat([f.content,Buffer.from('\n')])}:f)
 assert.throws(()=>historicalImports(changed),/missing, duplicate or changed/)
})
test('unavailable or mismatched frozen source cannot grant an exception',()=>{
 const entries=historicalImports(files())
 assert.throws(()=>verifyHistoricalSources(entries,()=>{throw Error('unavailable')}),/unavailable/)
 assert.throws(()=>verifyHistoricalSources(entries,()=>Buffer.from('different')),/source mismatch/)
})
test('only chronology of exact imports is exempt; all other checks remain',()=>{
 const f=textFiles(),names=new Set(historicalImports(files()).map(e=>e.path.slice(8)))
 const main=f.filter(x=>!names.has(x.name)).map(x=>x.name)
 assert.deepEqual(checkMigrations(f,main,undefined,names),[])
 assert.ok(checkMigrations([...f,{name:'20261025010000_new_old.sql',content:''}],main,undefined,names).some(p=>p.includes('晚于 main')))
 assert.ok(checkMigrations([...f,{name:'20261325010000_invalid.sql',content:''}],main,undefined,names).some(p=>p.includes('时间合法')))
 const name=[...names][0],ts=name.slice(0,14)
 assert.ok(checkMigrations([...f,{name:ts+'_duplicate.sql',content:''}],main,undefined,names).some(p=>p.includes('时间戳和')))
 assert.ok(checkMigrations(f.map(x=>x.name==='0001_agents_devices.sql'?{...x,content:x.content+'\n'}:x),main,undefined,names).some(p=>p.includes('不能修改')))
})
test('fresh main failure never falls back to stale origin/main or null',()=>{
 const calls=[]
 assert.throws(()=>currentMainMigrations((...args)=>{calls.push(args);throw Error('network unavailable')}),/network unavailable/)
 assert.equal(calls[0][0],'fetch'); assert.match(calls[0][4],/^refs\/heads\/main:refs\/mikka-migration-check\//)
 assert.equal(calls[1][0],'update-ref')
 assert.throws(()=>currentMainMigrations((command)=>Buffer.from(command==='rev-parse'?'a'.repeat(40):'')),/inventory unavailable/)
})

test('unrelated fetch cannot replace the frozen current-main comparison',()=>{
 const sha='a'.repeat(40),calls=[];let ref
 const main=currentMainMigrations((...args)=>{
  calls.push(args)
  if(args[0]==='fetch'){ref=args[4].split(':')[1];return Buffer.from('')}
  if(args[0]==='rev-parse'){assert.equal(args[1],ref);assert.notEqual(args[1],'FETCH_HEAD');return Buffer.from(sha)}
  if(args[0]==='ls-tree'){assert.equal(args[2],sha);return Buffer.from('drizzle/20261025232201_example.sql\n')}
  return Buffer.from('')
 })
 assert.equal(main.sha,sha);assert.deepEqual(main.files,['20261025232201_example.sql'])
 assert.ok(calls.some(c=>c[0]==='update-ref'&&c[2]===ref))
})
