import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
const env={PATH:process.env.PATH}
test('native required profile declares the registered native test and exact count',()=>{
 const r=spawnSync(process.execPath,['scripts/test-group-native-required.mjs','--describe'],{encoding:'utf8',env})
 assert.equal(r.status,0);const p=JSON.parse(r.stdout);assert.equal(p.tests,10)
 const source=readFileSync(p.file,'utf8');assert.equal((source.match(/await t\.test\(/g)??[]).length+1,p.tests)
 assert.ok(source.includes(p.requiredNames[1]))
})
test('retention flags alone never authorize native runtime disposal',()=>{
 const r=spawnSync(process.execPath,['scripts/test-group-native-required.mjs','lib/group-mailbox-runtime.test.ts'],{encoding:'utf8',env:{...env,KEEP_GROUP_TEST_FIXTURES:'1',KEEP_NATIVE_TEST_FIXTURES:'1'}})
 assert.notEqual(r.status,0);assert.match(r.stderr,/explicit authorization/);assert.doesNotMatch(r.stdout,/# Subtest:/)
})
test('Factory HTTP profile requires explicit flag and rejects foreign database before tests',()=>{
 const disabled=spawnSync(process.execPath,['scripts/test-factory-question-http.mjs','tests/factory-question-http.test.ts'],{encoding:'utf8',env})
 assert.notEqual(disabled.status,0);assert.match(disabled.stderr,/explicitly enabled/)
 const foreign=spawnSync(process.execPath,['scripts/test-factory-question-http.mjs','tests/factory-question-http.test.ts'],{encoding:'utf8',env:{...env,FACTORY_QUESTION_LOCAL_HTTP:'1',FACTORY_QUESTION_HTTP_ORIGIN:'http://localhost:3120',FACTORY_QUESTION_DATABASE_URL:'postgres://factoryquestions192@example.invalid/mikka_e2e'}})
 assert.notEqual(foreign.status,0);assert.doesNotMatch(foreign.stdout,/# Subtest:/)
})
test('native integration rejects shared or suffix-only workspace databases before fixtures',()=>{
 for(const database of ['mikka_e2e','arbitrary_e2e']){
  const r=spawnSync(process.execPath,['scripts/test-group-native-required.mjs','lib/group-mailbox-runtime.test.ts'],{encoding:'utf8',env:{...env,MIKKA_NATIVE_DISPOSAL_AUTHORIZED:'1',MIKKA_DISPOSABLE_POSTGRES_URL:'postgres://synthetic@127.0.0.1/mikka_review',MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL:`postgres://synthetic@127.0.0.1/${database}`}})
  assert.notEqual(r.status,0);assert.match(r.stderr,/Workspace database must be exactly/);assert.doesNotMatch(r.stdout,/# Subtest:/)
 }
 const profiles=JSON.parse(readFileSync('scripts/backend-acceptance-profiles.json','utf8')).profiles
 const native=profiles.find(p=>p.name==='group-native-required')
 assert.equal(native.workspaceDatabase,'mikka_workspace_review');assert.equal(native.requireDistinctWorkspaceDatabase,true)
})

test('native group app rejects the separate Factory database before fixtures',()=>{
 const r=spawnSync(process.execPath,['scripts/test-group-native-required.mjs','lib/group-mailbox-runtime.test.ts'],{encoding:'utf8',env:{...env,MIKKA_NATIVE_DISPOSAL_AUTHORIZED:'1',MIKKA_DISPOSABLE_POSTGRES_URL:'postgres://synthetic@127.0.0.1/mikka_e2e',MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL:'postgres://synthetic@127.0.0.1/mikka_workspace_review'}})
 assert.notEqual(r.status,0);assert.match(r.stderr,/App database must be exactly mikka_review/);assert.doesNotMatch(r.stdout,/# Subtest:/)
 const native=JSON.parse(readFileSync('scripts/backend-acceptance-profiles.json','utf8')).profiles.find(p=>p.name==='group-native-required')
 assert.deepEqual(native.appDatabases,['mikka_review']);assert.equal(native.appBinding,'R0_GROUP_APP_DATABASE_URL')
})

test('automatic mailbox workflow cannot reuse a previous native deletion approval',()=>{
 const workflow=readFileSync('.github/workflows/mailboxes.yml','utf8')
 assert.doesNotMatch(workflow,/MIKKA_NATIVE_DISPOSAL_AUTHORIZED\s*:/)
 assert.match(workflow,/BLOCKED: this automatic run has no run-specific native resource deletion authorization/)
 assert.ok(workflow.indexOf('Native authorization is pending')<workflow.indexOf('pnpm test:groups'))
 assert.match(workflow,/exit 1/)
 assert.match(workflow,/mailboxes:\n    needs: native-authorization/)
 assert.doesNotMatch(workflow.split('  mailboxes:')[0],/services:/)
 assert.match(workflow,/MIKKA_TEST_NATIVE_GROUPS: '1'/)
 assert.match(workflow,/pnpm test:group-native/)
 const native=JSON.parse(readFileSync('scripts/backend-acceptance-profiles.json','utf8')).profiles[0]
 assert.equal(native.requiredEnvironment.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,undefined)
 assert.equal(native.authorizationPrerequisite.automaticGrant,false)
})
