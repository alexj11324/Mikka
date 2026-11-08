import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),driver=resolve(process.argv[2])
const m=JSON.parse(readFileSync(join(here,'manifest.json'),'utf8'))
const hash=x=>createHash('sha256').update(x).digest('hex')
assert.equal(m.schemaVersion,1);assert.equal(m.issue,1506)
assert.equal(m.sourceSha,'3c6bddac19eb3d22c208cb17e6b2efd7a388687d')
assert.equal(m.applicationSha,'f1324dafa296f76289124bb93538f1938cb1597f')
assert.equal(m.modelSendsAllowed,0)
assert.deepEqual(m.cases.map(x=>x.key),['public-haiku','public-luna','private-haiku'])
let attempts=0
globalThis.fetch=()=>{attempts++;throw Error('offline_network_forbidden')}
globalThis.WebSocket=class {constructor(){attempts++;throw Error('offline_network_forbidden')}}
const {validateFixtureReceipt}=await import(pathToFileURL(join(driver,'scripts/acceptance/issue-1506-alex/coordinator-fixtures.mjs')))
const {validateGroupReceipt,groupName}=await import(pathToFileURL(join(driver,'scripts/acceptance/issue-1506-alex/group-stop.mjs')))
const raw=readFileSync(join(driver,m.fixture.path));assert.equal(hash(raw),m.fixture.sha256)
const fixtures=validateFixtureReceipt(JSON.parse(raw),{ready:true})
assert.equal(fixtures.workspace.id,'0a700222-137b-4bca-b86d-a74b8fdffc21')
for(const f of m.sourceFiles)assert.equal(hash(readFileSync(join(driver,f.path))),f.sha256)
for(const row of m.cases){
 const raw=readFileSync(join(here,row.file));assert.equal(hash(raw),row.sha256)
 const r=validateGroupReceipt(JSON.parse(raw),fixtures)
 assert.equal(r.applicationSha,m.applicationSha);assert.equal(r.groupId,row.groupId);assert.equal(r.messageId,row.messageId)
 assert.equal(r.scenario+'-'+r.fixtureKey,row.key);assert.equal(r.messageSendAttempts,1);assert.equal(r.createAttempted,true)
 assert.equal(r.stop.acknowledged,true);assert.equal(r.stop.stoppedTurns,1);assert.equal(r.afterStop.active,false)
 assert.equal(r.cleanup.retainedForProviderAudit,true);assert.equal(groupName(r),row.groupTitle)
}
assert.equal(attempts,0)
const r={schemaVersion:1,issue:1506,phase:'group-cleanup-offline-preflight',cases:m.cases.map(x=>x.key),sourceSha:m.sourceSha,actualOriginalModuleImports:true,originalReceiptValidators:true,networkAttempts:attempts,cleanupCalls:0,modelSends:0}
mkdirSync('group-cleanup-report',{recursive:true});writeFileSync('group-cleanup-report/preflight.json',JSON.stringify(r,null,2)+'\n')
console.log(JSON.stringify(r))
