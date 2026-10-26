import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
export const profile={name:'group-native-required',file:'lib/group-mailbox-runtime.test.ts',tests:10,requiredNames:['actual HTTP dispatch → group mailbox → isolated fake worker → trusted revision','actual daemon startup routes BOTH CC/Codex CLI adapters with isolated fake binaries']}
if(process.argv.includes('--describe')){console.log(JSON.stringify(profile,null,2));process.exit(0)}
assert.equal(process.argv[2],profile.file,'Required native test file must remain explicit')
// Retained DB/build fixtures do not disable the real adapter cancellation and
// container disposal contract. Never silently omit the native subtest.
assert.equal(process.env.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,'1','Native profile requires explicit authorization for its task-owned runtime container/process disposal; KEEP_GROUP_TEST_FIXTURES is insufficient')
for(const value of [process.env.MIKKA_DISPOSABLE_POSTGRES_URL,process.env.MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL??process.env.MIKKA_DISPOSABLE_POSTGRES_URL]){const url=new URL(value);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.hostname,'127.0.0.1');assert.ok(['/mikka_review','/mikka_e2e','/mikka_workspace_review'].includes(url.pathname));assert.equal(url.search,'');assert.equal(url.hash,'')}
const result=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',profile.file],{encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,MIKKA_TEST_NATIVE_GROUPS:'1',KEEP_GROUP_TEST_FIXTURES:'1',KEEP_NATIVE_TEST_FIXTURES:'1'}})
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'')
assert.equal(result.status,0,'Required native profile failed')
for(const name of profile.requiredNames)assert.ok(result.stdout.includes(`# Subtest: ${name}`),`Missing required native test: ${name}`)
for(const [key,n] of Object.entries({tests:profile.tests,pass:profile.tests,fail:0,skipped:0,cancelled:0,todo:0}))assert.match(result.stdout,new RegExp(`^# ${key} ${n}$`,'m'),`Unexpected native ${key} count`)
