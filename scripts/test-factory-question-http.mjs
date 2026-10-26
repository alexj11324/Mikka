import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const file='tests/factory-question-http.test.ts'
assert.equal(process.argv[2],file)
assert.equal(process.env.FACTORY_QUESTION_LOCAL_HTTP,'1','Post-build HTTP profile must be explicitly enabled')
const origin=new URL(process.env.FACTORY_QUESTION_HTTP_ORIGIN),db=new URL(process.env.FACTORY_QUESTION_DATABASE_URL)
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'localhost');assert.equal(origin.username,'');assert.equal(origin.password,'')
assert.ok(['postgres:','postgresql:'].includes(db.protocol));assert.equal(db.hostname,'127.0.0.1');assert.equal(db.username,'factoryquestions192');assert.equal(db.pathname,'/mikka_e2e');assert.equal(db.search,'');assert.equal(db.hash,'')
assert.ok(existsSync('.next/BUILD_ID'),'Build must finish before Factory question HTTP acceptance')
assert.ok(readFileSync('.next/BUILD_ID','utf8').trim())
const r=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',file],{encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,FACTORY_QUESTION_RETAIN_FIXTURES:'1'}})
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');assert.equal(r.status,0)
assert.ok(r.stdout.includes('# Subtest: real local question HTTP: owner, origin, replay, cancellation and isolation'))
for(const [key,n] of Object.entries({tests:1,pass:1,fail:0,skipped:0,cancelled:0,todo:0}))assert.match(r.stdout,new RegExp(`^# ${key} ${n}$`,'m'))
