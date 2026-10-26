// REQUIRE_DB: retained original Factory setup through the create-only bootstrap.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {FACTORY_CREATEONLY_CATALOG_SHA256,normalizeFactorySchemaDump} from '../lib/factory/create-only-bootstrap.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
import {parseSummary} from '../scripts/run-db-tests.mjs'
test('original Factory agent setup retains complete fixture PK registration without disposal',async()=>{
 assert.equal(process.env.FACTORY_AGENT_SETUP_ONLY,'1')
 assert.notEqual(process.env.FACTORY_PHYSICAL_ABSENCE_AUTHORIZED,'1')
 assert.ok(process.env.E2E_DATABASE_URL)
 const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT
 const result=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap','lib/factory/postgres.test.ts'],{env:childEnv,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
 const output=(result.stdout??'')+(result.stderr??'')
 await mkdir('test-results/r0',{recursive:true})
 await writeFile('test-results/r0/factory-agent-setup-child.log',output,{mode:0o600})
 assert.equal(result.status,0,'original setup-only child failed; retained child log has details')
 assert.deepEqual(parseSummary(output),{tests:1,pass:1,fail:0,cancelled:0,skipped:0,todo:0})
 const schema=/Retained Factory schema: (factory_192_[a-f0-9]{32})/.exec(output)?.[1];assert.ok(schema)
 const container=process.env.HISTORY_PG_CONTAINER
 if(container)assert.match(container,/^[a-f0-9]{64}$/)
 const version=execFileSync(container?'docker':'pg_dump',container?['exec',container,'pg_dump','--version']:['--version'],{encoding:'utf8'});assert.match(version,/PostgreSQL\) 17\./)
 const target=new URL(process.env.E2E_DATABASE_URL)
 const args=['--schema-only','--no-owner','--no-privileges','--schema='+schema]
 const dump=execFileSync(container?'docker':'pg_dump',container?['exec',container,'pg_dump','-U',decodeURIComponent(target.username),...args,target.pathname.slice(1)]:[...args,process.env.E2E_DATABASE_URL],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000})
 const normalized=normalizeFactorySchemaDump(dump,schema)
 await writeFile('test-results/r0/factory-agent-setup-schema.sql',dump,{mode:0o600})
 assert.equal(createHash('sha256').update(normalized).digest('hex'),FACTORY_CREATEONLY_CATALOG_SHA256,'create-only logical catalog differs from frozen original migration reference')
})
