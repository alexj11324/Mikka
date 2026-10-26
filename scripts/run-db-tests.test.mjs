import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SELF_MANAGED, inventory, main, readTree, validateTarget } from './run-db-tests.mjs'
import { coveragePlan, databaseIdentity, profileEnvironment, parseEvidence, executePhase, aggregate, resultError } from './db-test-plan.mjs'
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
 assert.equal(p.files.length,41);assert.equal(p.recipes.length,23);assert.deepEqual(p.expected,c.expected)
 for(const id of ['credentials','groups','group-native','operations','migration-session','improvement','byos-claim','byos-worker','factory-question-http'])assert.ok(p.expected.includes(id))
 assert.ok(p.contractErrors.length>0,'unverified result contracts remain failed, not excluded');
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
 assert.equal(c.recipes.find(r=>r.id==='factory').status,'pending')
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
