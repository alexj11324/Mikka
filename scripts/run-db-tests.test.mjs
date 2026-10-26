import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SELF_MANAGED, inventory, main, readTree, validateTarget } from './run-db-tests.mjs'
import { failureDiagnostics, coveragePlan, databaseIdentity, profileEnvironment, parseEvidence, executePhase, aggregate, resultError } from './db-test-plan.mjs'
const sha = 'a'.repeat(40), file = 'tests/example.db.test.ts'
const files = { [file]: "import { Pool } from 'pg'; test('actual DB exercise',()=>{})" }
const scripts = { 'test:example': `node --test ${file}` }
const target = 'postgresql://e2e:synthetic@127.0.0.1:5432/mikka_e2e'
const env = { CI: 'true', GITHUB_ACTIONS: 'true', E2E_DATABASE_URL: target, MIKKA_DATABASE_URL: target, DATABASE_URL: target, PATH: '/bin', COMPOSIO_API_KEY: 'must-not-inherit', VERCEL: 'must-not-inherit' }
const config = () => ({ version: 1, expected: ['example'], profiles: { isolated: { targets: [{ key: 'E2E_DATABASE_URL', database: 'mikka_e2e', host: '127.0.0.1', port: '5432' }], bindings: { MIKKA_DATABASE_URL: 'E2E_DATABASE_URL' }, env: {} } }, recipes: [{ id: 'example', files: [{ path: file, requiredNames: ['actual DB exercise'] }], command: ['pnpm', '-s', 'test:example'], packageScript: 'test:example', profile: 'isolated', phase: 'prebuild', status: 'ready', expectedTests: ['actual DB exercise'], expectedCount: 1 }] })
const plan = (c = config(), f = files, s = scripts, extra = {}) => coveragePlan(f, s, c, extra)
const output = 'ok 1 - actual DB exercise\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n'
const success = () => ({ status: 0, stdout: output, stderr: '' })

test('complete expected set, unknown/deleted files and duplicate primary coverage fail closed', () => {
 assert.deepEqual(plan().files, [file])
 assert.throws(() => plan(config(), { ...files, 'tests/unknown.db.test.ts': '' }), /Unregistered/)
 assert.throws(() => plan(config(), {}), /Missing\/overlapping/)
 for (const expected of [[], ['example', 'unknown'], ['example', 'example']]) assert.throws(() => plan(config(), files, scripts, { expected }), /expected/)
 const c = config(); c.recipes.push({ ...c.recipes[0], id: 'duplicate' }); c.expected.push('duplicate'); assert.throws(() => plan(c), /Duplicate primary/)
 assert.throws(() => plan(config(), { ...files, 'lib/feature.ts': '' }, scripts, { required: [{ marker: 'lib/feature.ts', file: 'tests/lost.db.test.ts' }] }), /Required feature/)
})
test('every recipe needs profile, DB contract, named tests, count, phase and a live invocation', () => {
 for (const change of [c=>delete c.profiles.isolated, c=>c.profiles.isolated.targets=[{}], c=>c.recipes[0].files[0].requiredNames=[], c=>c.recipes[0].expectedCount=0, c=>c.recipes[0].phase='any', c=>c.recipes[0].command=['echo','green']]) {
  const c=config(); change(c); assert.throws(()=>plan(c))
 }
 assert.throws(()=>plan(config(),files,{'test:example':'node -e 0'}),/no longer invokes/)
 const c=config();c.recipes[0].runner='scripts/special.mjs'
 assert.throws(()=>plan(c,files,{'test:example':'node scripts/special.mjs'}),/Missing live runner/)
 const f={...files,'scripts/special.mjs':`spawn('node',['--test','${file}'])`}
 assert.doesNotThrow(()=>plan(c,f,{'test:example':'node scripts/special.mjs'}))
 assert.throws(()=>plan(c,{...f,'scripts/special.mjs':'no invocation'}, {'test:example':'node scripts/special.mjs'}),/no longer invokes/)
})
test('native is an explicit named variant, not ambiguous duplicate or exclusion', () => {
 const c=config(); c.recipes[0].aliases=['test:native'];c.expected.push('native');c.recipes.push({...c.recipes[0],id:'native',variantOf:'example',packageScript:'test:native',command:['pnpm','-s','test:native'],phase:'postbuild'})
 assert.equal(plan(c,files,{...scripts,'test:native':`node --test ${file}`}).recipes.length,2)
 delete c.recipes[0].aliases;assert.throws(()=>plan(c,files,{...scripts,'test:native':`node --test ${file}`}),/Invalid explicit variant/)
})
test('original auth-email SELF_MANAGED is unchanged and not a passing recipe', () => {
 assert.deepEqual(SELF_MANAGED,[{file:'lib/auth-email.test.ts',runner:'scripts/test-auth-email.mjs',reason:'starts its own Docker Postgres and refuses any application database'}])
 const f={...files,'lib/auth-email.test.ts':"import { Pool } from 'pg'",'scripts/test-auth-email.mjs':"run('lib/auth-email.test.ts')"}
 const p=plan(config(),f,scripts,{selfManaged:SELF_MANAGED});assert.deepEqual(p.selfManaged,['lib/auth-email.test.ts']);assert.deepEqual(p.expected,['example'])
 assert.throws(()=>plan(config(),{...f,'scripts/test-auth-email.mjs':''},scripts,{selfManaged:SELF_MANAGED}),/self-managed/)
})
test('isolated profiles reject remote/options/DB mismatches and omit provider credentials', () => {
 const p=config().profiles.isolated
 const child=profileEnvironment(p,env,'prebuild');assert.equal(child.MIKKA_DATABASE_URL,target);assert.equal(child.RETAIN_SYNTHETIC_RECORDS,'1');assert.equal(child.COMPOSIO_API_KEY,undefined);assert.equal(child.VERCEL,undefined)
 assert.equal(databaseIdentity('postgres://a:one@localhost/same_e2e'),databaseIdentity('postgres://b:two@127.0.0.1:5432/same_e2e'))
 assert.equal(databaseIdentity('postgres://a@127.0.0.1/same%5Fe2e'),databaseIdentity('postgres://b@127.0.0.1/same_e2e'))
 for(const bad of ['postgres://remote/mikka_e2e',target+'?host=remote',target+'#fragment','postgres://e2e@localhost:6543/mikka_e2e','postgres://e2e@localhost/business','https://localhost/mikka_e2e'])assert.throws(()=>profileEnvironment(p,{...env,E2E_DATABASE_URL:bad},'prebuild'),/target/)
 assert.throws(()=>profileEnvironment(p,{...env,CI:''},'prebuild'),/isolated/)
 assert.throws(()=>profileEnvironment({...p,bindings:{X:'MISSING'}},env,'prebuild'),/binding/)
 assert.throws(()=>profileEnvironment({...p,env:{RETAIN_SYNTHETIC_RECORDS:'0'}},env,'prebuild'),/Cleanup/)
 assert.throws(()=>profileEnvironment({...p,distinct:['E2E_DATABASE_URL','DATABASE_URL']},env,'prebuild'),/Separate/)
 const http={...p,http:'ORIGIN'};assert.throws(()=>profileEnvironment(http,{...env,ORIGIN:'http://localhost:3100'},'prebuild'),/postbuild/)
 assert.doesNotThrow(()=>profileEnvironment(http,{...env,ORIGIN:'http://localhost:3100'},'postbuild'))
 assert.throws(()=>profileEnvironment(http,{...env,ORIGIN:'https://remote.example'},'postbuild'))
 assert.doesNotThrow(()=>validateTarget(env));assert.throws(()=>validateTarget({...env,DATABASE_URL:'postgres://remote/business'}))
})
test('test names and all counts are required; zero/skip/todo/fail/cancelled never pass', () => {
 const recipe=config().recipes[0], data={state:'passed',exitCode:0,...parseEvidence(output)}
 assert.equal(resultError(recipe,data),null)
 assert.deepEqual(parseEvidence('✔ actual DB exercise (1.23ms)\nℹ tests 1\nℹ pass 1\n').names,['actual DB exercise'])
 for(const key of ['tests','pass','fail','skipped','todo','cancelled']){const x=structuredClone(data);delete x.counts[key];assert.ok(resultError(recipe,x))}
 for(const key of ['fail','skipped','todo','cancelled']){const x=structuredClone(data);x.counts[key]=1;assert.ok(resultError(recipe,x))}
 for(const patch of [{names:[]},{counts:{...data.counts,tests:0,pass:0}},{names:['wrong']},{exitCode:1},{state:'blocked'}])assert.ok(resultError(recipe,{...data,...patch}))
})
test('pending, missing-profile and wrong-phase recipes never start a subprocess', () => {
 let calls=0;const run=()=>{calls++;return success()};const c=config();c.recipes[0].status='pending';c.recipes[0].pendingReason='retained harness not accepted'
 const blocked=executePhase(plan(c),'prebuild',sha,env,run);assert.equal(calls,0);assert.equal(blocked.results[0].state,'blocked')
 const failed=executePhase(plan(),'prebuild',sha,{...env,E2E_DATABASE_URL:undefined},run);assert.equal(calls,0);assert.equal(failed.results[0].state,'failed')
 assert.equal(executePhase(plan(),'postbuild',sha,env,run).results.length,0);assert.equal(calls,0)
 const post=config();post.recipes[0].phase='postbuild';assert.equal(executePhase(plan(post),'postbuild',sha,env,run).results[0].state,'blocked');assert.equal(calls,0)
 const passed=executePhase(plan(),'prebuild',sha,env,(cmd,args,opts)=>{assert.equal(opts.shell,false);assert.equal(opts.env.COMPOSIO_API_KEY,undefined);return success()});assert.equal(passed.results[0].state,'passed')
})
test('aggregation binds exact SHA/plan/profile/command/phase and every result once', () => {
 const p=plan(), report=executePhase(p,'prebuild',sha,env,success)
 assert.equal(aggregate(p,sha,[report]).passed,true)
 assert.equal(aggregate(p,sha,[]).passed,false)
 assert.equal(aggregate(p,sha,[null,{unreadable:'missing.json'}]).passed,false)
 assert.equal(aggregate(p,sha,[report,report]).passed,false)
 for(const patch of [{sha:'b'.repeat(40)},{digest:'wrong'},{phase:'external'}])assert.equal(aggregate(p,sha,[{...report,...patch}]).passed,false)
 for(const patch of [{profile:'wrong'},{command:['echo','pass']},{names:[]},{counts:null},{sha:'b'.repeat(40)}]){const x=structuredClone(report);Object.assign(x.results[0],patch);assert.equal(aggregate(p,sha,[x]).passed,false)}
 const c=config();c.recipes[0].status='pending';c.recipes[0].pendingReason='not verified';const pending=plan(c);const forged={...report,digest:pending.digest,results:report.results.map(r=>({...r,digest:pending.digest}))};assert.equal(aggregate(pending,sha,[forged]).passed,false)
 assert.notEqual(plan(config(),{...files,[file]:files[file]+'\n'}).digest,p.digest)
})
test('actual tree has exact complete R0 inventory, all previously missing suites and no new exclusions', () => {
 const pkg=JSON.parse(readFileSync('package.json','utf8')).scripts,c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')),p=inventory(readTree(),pkg)
 assert.equal(p.files.length,51);assert.equal(p.recipes.length,31);assert.deepEqual(p.expected,c.expected)
 for(const id of ['credentials','groups','group-native','operations','migration-session','improvement','byos-claim','byos-worker','factory-question-http'])assert.ok(p.expected.includes(id))
 assert.equal(p.contractErrors.length,0,'every retained and pending contract has explicit names/counts');
 assert.deepEqual(p.selfManaged,['lib/auth-email.test.ts']);assert.equal(p.recipes.find(r=>r.id==='group-native').status,'pending');assert.equal(p.recipes.find(r=>r.id==='factory-question-http').phase,'postbuild')
 let calls=0;assert.equal(main({env:{},run(){calls++}}),1);assert.equal(calls,0)
})

test('workflow invokes each DB recipe through one phase and enforces final complete result', () => {
 const workflow=readFileSync('.github/workflows/ui-policy.yml','utf8'), config=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8'))
 const pin=workflow.match(/DB_TEST_EXPECTED: ([^\n]+)/)?.[1].split(',');assert.deepEqual(pin,config.expected)
 for(const phase of ['prebuild','postbuild','external'])assert.equal(workflow.split(`pnpm test:db --phase ${phase} `).length-1,1)
 for(const script of ['test:visibility-db','test:issue-search-db','test:credentials','test:historical-upgrade-db'])assert.ok(!workflow.includes(`pnpm ${script}`))
 const dbJob=workflow.slice(workflow.indexOf('  browser-tests:'));assert.ok(!dbJob.includes('pnpm test:factory'));assert.ok(!dbJob.includes('pnpm test:groups'))
 assert.ok(workflow.includes('pnpm test:db --aggregate test-results/r0/prebuild.json test-results/r0/postbuild.json test-results/r0/external.json'))
 const aggregateStep=workflow.slice(workflow.indexOf('      - name: R0 complete same-SHA'),workflow.indexOf('      - uses: actions/upload-artifact@v4',workflow.indexOf('      - name: R0 complete same-SHA')))
 assert.ok(!aggregateStep.includes('continue-on-error'));assert.ok(aggregateStep.includes('if: always()'))
 assert.ok(dbJob.indexOf('tests/migrate-empty-db.test.mjs')<dbJob.indexOf('scripts/setup-e2e-db.mjs'))
 assert.ok(dbJob.indexOf('--phase prebuild')<dbJob.indexOf('- run: pnpm build'));assert.ok(dbJob.indexOf('- run: pnpm build')<dbJob.indexOf('--phase postbuild'))
 for(const pure of ['test:agent','test:issues','test:db-runner'])assert.ok(workflow.includes(`pnpm ${pure}`))
})

test('full case contracts reject omitted tests and duplicate-name substitutions', () => {
 const c=config();c.recipes[0].expectedTests=['actual DB exercise','second assertion'];c.recipes[0].expectedCount=2
 const r=c.recipes[0]
 assert.ok(resultError(r,{state:'passed',exitCode:0,...parseEvidence(output)}))
 const counts={tests:2,pass:2,fail:0,skipped:0,todo:0,cancelled:0}
 assert.ok(resultError(r,{state:'passed',exitCode:0,counts,names:['actual DB exercise','actual DB exercise']}))
 assert.equal(resultError(r,{state:'passed',exitCode:0,counts,names:['second assertion','actual DB exercise']}),null)
 const actual=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')).recipes.find(x=>x.id==='conversation-reads')
 assert.equal(actual.expectedCount,11)
 assert.ok(resultError(actual,{state:'passed',exitCode:0,counts,names:actual.files.map(x=>x.requiredNames[0])}))
 const pending=config();pending.recipes[0].status='pending';pending.recipes[0].pendingReason='owner must provide full case contract';pending.recipes[0].expectedTests=null;pending.recipes[0].expectedCount=null
 const p=plan(pending);assert.equal(p.contractErrors.length,1);assert.equal(aggregate(p,sha,[]).passed,false)
})
test('different credentials cannot make one database satisfy the two-database profile', () => {
 const p={targets:[{key:'APP',database:'shared_e2e',host:'127.0.0.1',port:'5432'},{key:'WS',database:'shared_e2e',host:'127.0.0.1',port:'5432'}],distinct:['APP','WS'],bindings:{APP:'APP',WS:'WS'},env:{}}
 assert.throws(()=>profileEnvironment(p,{...env,APP:'postgres://one:first@127.0.0.1:5432/shared_e2e',WS:'postgres://two:second@127.0.0.1/shared_e2e'},'prebuild'),/Separate databases/)
})

test('groups profile uses the exact common harness database pair, never an arbitrary suffix', () => {
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')),p=c.profiles.groups
 const local={...env,R0_GROUP_APP_DATABASE_URL:'postgres://fixture@127.0.0.1:5432/mikka_review',R0_WORKSPACE_DATABASE_URL:'postgres://fixture@127.0.0.1:5432/mikka_workspace_review',BETTER_AUTH_SECRET:'synthetic-test-only'}
 const child=profileEnvironment(p,local,'prebuild')
 assert.equal(child.MIKKA_DISPOSABLE_POSTGRES_URL,local.R0_GROUP_APP_DATABASE_URL)
 assert.equal(child.MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL,local.R0_WORKSPACE_DATABASE_URL)
 assert.equal(child.MIKKA_DATABASE_URL,local.R0_GROUP_APP_DATABASE_URL)
 assert.deepEqual(p.distinct,['R0_GROUP_APP_DATABASE_URL','R0_WORKSPACE_DATABASE_URL'])
 for(const database of ['another_e2e','mikka_e2e','mikka_review'])assert.throws(()=>profileEnvironment(p,{...local,R0_WORKSPACE_DATABASE_URL:`postgres://fixture@127.0.0.1:5432/${database}`},'prebuild'),/Invalid isolated target/)
 assert.throws(()=>profileEnvironment(p,{...local,R0_GROUP_APP_DATABASE_URL:target},'prebuild'),/Invalid isolated target/)
 assert.equal(c.recipes.find(r=>r.id==='groups').status,'ready');assert.equal(c.recipes.find(r=>r.id==='group-native').status,'pending')
})

test('Factory uses existing CI paths without incompatible local fixture overrides', () => {
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')),p=c.profiles.factory
 const localKeys=['FACTORY_TEST_DATABASE_URL','FACTORY_QUESTION_TEST_URL','FACTORY_CYCLE_TEST_URL','FACTORY_MONITOR_DISPATCH_TEST_URL']
 const supplied={...env,BETTER_AUTH_SECRET:'synthetic-test-only',...Object.fromEntries(localKeys.map(k=>[k,'postgres://wrong@localhost/invalid']))}
 const child=profileEnvironment(p,supplied,'prebuild')
 for(const key of localKeys)assert.equal(child[key],undefined)
 assert.equal(child.FACTORY_LOCAL_DB_TESTS,undefined)
 // monitor has no E2E fallback, but explicitly accepts this exact CI service URL.
 assert.equal(child.FACTORY_MONITOR_TEST_URL,target)
 assert.equal(child.CI,'true');assert.equal(child.GITHUB_ACTIONS,'true')
 assert.throws(()=>profileEnvironment(p,{...supplied,GITHUB_ACTIONS:undefined,MIKKA_ISOLATED_R0:'1'},'prebuild'),/GitHub CI service/)
 assert.throws(()=>profileEnvironment(p,{...supplied,E2E_DATABASE_URL:target.replace('postgresql:','postgres:')},'prebuild'),/Invalid isolated target/)
 assert.equal(c.recipes.find(r=>r.id==='factory').status,'ready')
})

 test('296 contracts separate retained groups, blocked native and actual postbuild HTTP',()=>{
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8'))
 const groups=c.recipes.find(r=>r.id==='groups'),native=c.recipes.find(r=>r.id==='group-native'),http=c.recipes.find(r=>r.id==='factory-question-http')
 assert.equal(groups.expectedCount,45);assert.equal(native.expectedCount,10)
 assert.ok(!groups.expectedTests.includes(native.files[0].requiredNames[0]));assert.ok(native.expectedTests.includes(native.files[0].requiredNames[0]))
 assert.equal(c.profiles.groups.env.MIKKA_TEST_NATIVE_GROUPS,undefined)
 assert.equal(c.profiles['group-native'].env.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,undefined)
 assert.equal(c.profiles['group-native'].bindings.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,'MIKKA_NATIVE_DISPOSAL_AUTHORIZED')
 const p=inventory(readTree(),JSON.parse(readFileSync('package.json','utf8')).scripts)
 let nativeCalls=0
 const result=executePhase(p,'postbuild',sha,{...env,R0_BUILD_SUCCEEDED:'success'},()=>{nativeCalls++;return success()})
 assert.equal(result.results.find(r=>r.id==='group-native').state,'blocked');assert.equal(nativeCalls,0)
 assert.equal(http.runner,'scripts/test-factory-question-http.mjs');assert.equal(http.phase,'postbuild');assert.equal(http.expectedCount,1)
 assert.equal(c.profiles[http.profile].env.FACTORY_QUESTION_RETAIN_FIXTURES,'1')
 const workflow=readFileSync('.github/workflows/mailboxes.yml','utf8')
 assert.ok(!/MIKKA_NATIVE_DISPOSAL_AUTHORIZED:.*1/.test(workflow))
 })

test('merged workflow cannot resurrect implicit DB runner or direct destructive harnesses',()=>{
 const workflow=readFileSync('.github/workflows/ui-policy.yml','utf8'), job=workflow.slice(workflow.indexOf('  browser-tests:'))
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8'))
 assert.equal((workflow.match(/DB_TEST_EXPECTED:/g)??[]).length,1)
 assert.ok(!/run: pnpm test:db\s*\n/.test(job))
 assert.ok(!job.includes('pnpm test:e2e:setup'))
 assert.ok(job.indexOf('node --test scripts/run-db-tests.test.mjs scripts/backend-recipes.test.mjs')>=0)
 assert.ok(job.indexOf('node --test scripts/run-db-tests.test.mjs scripts/backend-recipes.test.mjs')<job.indexOf('tests/migrate-empty-db.test.mjs'))
 for(const recipe of c.recipes)for(const file of recipe.files)assert.ok(!job.includes(file.path),`DB file must execute only through its explicit phase/profile: ${file.path}`)
})

test('pending BYOS recipes cannot escape R0 via the legacy independent workflow',()=>{
 const workflow=readFileSync('.github/workflows/byos.yml','utf8')
 assert.ok(workflow.includes('needs: retention-authorization'))
 const gate=workflow.slice(workflow.indexOf('  retention-authorization:'),workflow.indexOf('  backend:'))
 assert.ok(gate.includes('fix/168-170-data-integration'));assert.ok(gate.includes('exit 1'))
 assert.ok(!gate.includes('services:'));assert.ok(!gate.includes('actions/checkout'))
})

test('BYOS claim provisioner requires retained fixtures and has no automatic disposal path', async () => {
 const {spawnSync}=await import('node:child_process')
 const source=readFileSync('scripts/test-byos-claim.mjs','utf8')
 assert.doesNotMatch(source,/--rm|\['rm'|\['remove'/)
 assert.match(source,/run\(\['stop',name\]\)/)
 const result=spawnSync(process.execPath,['scripts/test-byos-claim.mjs'],{encoding:'utf8',env:{PATH:'/nonexistent'}})
 assert.notEqual(result.status,0)
 assert.match(result.stderr,/requires explicit retained synthetic fixtures/)
 assert.doesNotMatch(result.stderr,/spawnSync docker|ENOENT/)
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json'))
 const recipe=c.recipes.find(r=>r.id==='byos-claim')
 assert.equal(recipe.status,'ready');assert.equal(recipe.expectedCount,1)
 assert.deepEqual(recipe.expectedTests,recipe.files[0].requiredNames)
 assert.equal(c.profiles['byos-claim'].provisionedTarget.retention,'stopped-and-retained')
})

test('shared harness support bytes are required and invalidate prior recipe evidence',()=>{
 const c=config();c.recipes[0].supportFiles=['tests/helper.ts']
 assert.throws(()=>plan(c),/support files/)
 const a=plan(c,{...files,'tests/helper.ts':'real assertion A'})
 const b=plan(c,{...files,'tests/helper.ts':'real assertion B'})
 assert.notEqual(a.digest,b.digest)
 for(const bad of [['tests/helper.ts','tests/helper.ts'],['missing.ts'],[null]]){
  const changed=structuredClone(c);changed.recipes[0].supportFiles=bad
  assert.throws(()=>plan(changed,{...files,'tests/helper.ts':'real assertion A'}),/support files/)
 }
})

test('credential retained and disposal contracts cover every shared-harness scenario explicitly',()=>{
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json'))
 const retained=c.recipes.find(r=>r.id==='credentials'),disposal=c.recipes.find(r=>r.id==='credentials-disposal')
 const source=readFileSync('lib/credentials/acceptance-harness.ts','utf8')
 const cases=[...source.matchAll(/await scenario\('([^']+)'/g)].map(m=>m[1])
 for(const name of cases)assert.equal([retained,disposal].filter(r=>r.expectedTests.includes(name)).length,1)
 assert.equal(disposal.status,'pending');assert.equal(disposal.expectedCount,7)
 assert.equal(retained.expectedCount,26)
 for(const r of [retained,disposal])assert.ok(r.supportFiles.includes('lib/credentials/acceptance-harness.ts'))
 assert.match(readFileSync('lib/credentials/disposal.db.test.ts','utf8'),/throw new Error\('Pending scoped approval/)
 assert.doesNotMatch(readFileSync('scripts/test-credential-backend.mjs','utf8'),/DROP DATABASE/)
})


test('failure diagnostics retain status/assertion locations but never credential strings or bodies',()=>{
 const raw = "code: 'ERR_ASSERTION'\nexpected: 200\nactual: 429\nerror: secret-token-DO-NOT-RETAIN\nactual: 'secret-cookie-DO-NOT-RETAIN'\n at signup (/home/runner/work/project/tests/factory-question-http.test.ts:66:14)\nhttps://private.example/secret?token=DO-NOT-RETAIN"
 const result=failureDiagnostics(raw)
 assert.deepEqual(result,{goCases:[],codes:['ERR_ASSERTION'],assertions:[{kind:'expected',value:200},{kind:'actual',value:429}],locations:['tests/factory-question-http.test.ts:66:14']})
 assert.doesNotMatch(JSON.stringify(result),/secret|cookie|private|token|DO-NOT/)
 assert.deepEqual(failureDiagnostics("R0_FAILED_CASE: TestKnownFixture\nR0_FAILED_CASE: secret-token").goCases,["TestKnownFixture"])
})

test('retained partitions preserve pending physical contracts and bind Go allowlist sources', () => {
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')), tree=readTree()
 const r=id=>c.recipes.find(r=>r.id===id)
 assert.equal(r('audit').expectedCount,11);assert.equal(r('audit-deletion').status,'pending');assert.equal(r('audit-deletion').expectedCount,3)
 assert.equal(r('factory').expectedCount,118);assert.equal(r('factory-physical-absence').status,'pending')
 for(const name of ['deleted agent cascades its run and blocks reconciliation','missing verification run blocks candidate recovery','reuse across issues preserves the original mapping and existing issue deletion cascade','missing continuation blocks durably and retains its answer']) {
  assert.ok(r('factory-physical-absence').expectedTests.includes(name));assert.ok(!r('factory').expectedTests.includes(name))
 }
 const go=JSON.parse(tree['packages/subscription-worker/retained-test-contract.json'])
 const sources=Object.entries(tree).filter(([p])=>p.startsWith('packages/subscription-worker/')&&p.endsWith('_test.go')).flatMap(([,s])=>[...s.matchAll(/func (Test\w+)\(t \*testing.T\)/g)].map(m=>m[1]))
 const registered=[...go.retainedTests,...go.pendingTests.map(t=>t.name),...go.separateApplicationIntegration]
 assert.deepEqual([...sources].sort(),[...registered].sort());assert.equal(new Set(registered).size,registered.length)
 assert.equal(r('byos-retained').expectedCount,49)
 for(const name of go.pendingTests.map(t=>t.name))assert.ok(!r('byos-retained').expectedTests.includes(name))
 const pkg=JSON.parse(readFileSync('package.json','utf8')).scripts
 const before=inventory(tree,pkg).digest
 const changed={...tree,'packages/subscription-worker/integration_test.go':tree['packages/subscription-worker/integration_test.go']+'\n'}
 assert.notEqual(inventory(changed,pkg).digest,before)
})

test('full BYOS disposal is a separate exact pending partition and refuses unapproved startup',()=>{
 const c=JSON.parse(readFileSync('scripts/db-test-recipes.json','utf8')),r=c.recipes.find(r=>r.id==='byos-worker'),g=JSON.parse(readFileSync('packages/subscription-worker/retained-test-contract.json','utf8'))
 assert.equal(r.status,'pending');assert.equal(r.expectedCount,23)
 for(const name of g.retainedTests)assert.ok(!r.expectedTests.includes(name))
 for(const item of g.pendingTests)assert.ok(r.expectedTests.includes(item.name))
 const source=readFileSync('scripts/test-subscription-worker.mjs','utf8')
 assert.ok(source.indexOf('BYOS_FULL_DISPOSAL_AUTHORIZED') < source.indexOf('const reserve = createServer'))
 assert.ok(!source.includes('"--rm"'));assert.ok(!source.includes('go test -mod=readonly -race -timeout 90s'))
 assert.equal(c.profiles['byos-worker'].env.BYOS_FULL_DISPOSAL_AUTHORIZED,undefined)
 const shared=readFileSync('tests/byos-application-harness.mjs','utf8')
 const guard=shared.slice(shared.indexOf('export function registerByosApplication(mode) {')+'export function registerByosApplication(mode) {'.length,shared.indexOf("  test(mode ==="))
 const check=new Function('mode','process',guard)
 assert.throws(()=>check('disposal',{env:{BYOS_FULL_DISPOSAL_AUTHORIZED:'1',RETAIN_SYNTHETIC_RECORDS:'1',MIKKA_BYOS_BACKEND_ONLY:'1'}}),/cannot omit browser/)

 const execution=spawnSync(process.execPath,['scripts/test-subscription-worker.mjs'],{encoding:'utf8',env:{PATH:process.env.PATH,RETAIN_SYNTHETIC_RECORDS:'1'}})
 assert.notEqual(execution.status,0);assert.match(execution.stderr,/Pending scoped approval/);assert.equal(execution.stdout,'')
})
