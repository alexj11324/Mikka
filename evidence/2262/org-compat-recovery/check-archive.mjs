import {execFileSync, spawnSync} from 'node:child_process'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const app=createRequire(resolve('package.json'))
const {dependencyTestCommand}=await import(pathToFileURL(resolve('scripts/ci/self-hosted-requirements.mjs')))
const expected='6717676486671cc827b134eccc1695e55fe05c72'
const tree='924418a9b453ed387665a1bca96c4c11783fea6d'
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
assert.equal(git('rev-parse','HEAD'),expected);assert.equal(git('rev-parse','HEAD^{tree}'),tree)
const dir=resolve(process.env.RUNNER_TEMP,'compat-qa-receipt')
mkdirSync(dir,{recursive:true,mode:0o700})
const decl=app('./config/self-hosted-requirements.json')['lib/governance/organizations.ts']
const scripts=app('./package.json').scripts
const governance=dependencyTestCommand(decl,scripts)
assert.equal(decl.mode,'built-in');assert.deepEqual(decl.environment,[]);assert.equal(decl.suite,'test:enterprise-db')
assert.equal(governance.at(-1),'lib/enterprise/governance.db.test.ts')
const p=app('pg');const pg=new p.Pool({connectionString:process.env.E2E_DATABASE_URL})
const pgVersion=(await pg.query("select current_setting('server_version_num') as version")).rows[0].version
assert.equal(Math.floor(Number(pgVersion)/10000),17)
await pg.end()
const run = (label,argv) => {
  const start=new Date().toISOString()
  const ran=spawnSync(argv[0],argv.slice(1),{encoding:'utf8',maxBuffer:20*1024*1024,env:{...process.env,FORCE_COLOR:'0',NODE_DISABLE_COLORS:'1'}})
  const output=(ran.stdout??'')+'\n'+(ran.stderr??'')
  const lines=output.split(/\r?\n/).map(l=>l.replace(/\x1b\[[0-9;]*m/g,'').trim())
  const safe=l=>l.replace(/(?:https?|postgres(?:ql)?)\S*:\/\/\S+/ig,'[endpoint]').replace(/(?:(?:gh[pousr]_|sk-proj-)[A-Za-z0-9_\-]+|Bearer\s+[A-Za-z0-9._-]+)/gi,'[redacted]')
  const named=lines.filter(l=>/^(?:(?:not )?ok \d+ - |[✔✖▶] |[ℹ#] (tests|pass|fail|cancelled|skipped|todo) \d+$)/u.test(l)).map(safe)
  const counts={};for(const l of named){const m=l.match(/^[#ℹ] (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u);if(m)counts[m[1]]=(counts[m[1]]??0)+Number(m[2])}
  const receipt={label,source:expected,tree,pgVersion,started:start,ended:new Date().toISOString(),status:ran.status,signal:ran.signal,argv:argv.map(x=>x===process.execPath?'node':x),declaration:decl,counts,named}
  writeFileSync(resolve(dir,label+'.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(label,JSON.stringify({start,end:receipt.ended,status:ran.status,counts}))
  for(const l of named)console.log(l)
  if(ran.status!==0)for(const l of lines.filter(l=>/^(?:error:|code:|failureType:|expected:|actual:|Error:|AssertionError)/i.test(l)).slice(0,30))console.log(safe(l))
  assert.equal(ran.status,0);assert.ok(counts.tests>0);assert.equal(counts.pass,counts.tests);for(const key of ['fail','skipped','todo','cancelled'])assert.equal(counts[key],0)
}
run('active-owner',[process.execPath,'--experimental-test-module-mocks','--import','./scripts/server-test.mjs','--import','tsx','--test-force-exit','--test','qa-harness/evidence/2262/org-compat-recovery/archive-access.test.ts'])
