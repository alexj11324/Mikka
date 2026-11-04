import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const root = process.env.MIKKA_PENDING_REPO ?? '/vercel/sandbox/mikka-pending-live'
assert.ok(['/vercel/sandbox/mikka-pending-live', '/home/agent/workspace/mikka-pending-live'].includes(root), 'isolated approval worktree required')
const sha=process.env.MIKKA_PENDING_VISUAL_SHA
assert.match(sha ?? '', /^[0-9a-f]{40}$/)
const short=sha.slice(0,7)
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sha)
execFileSync('git',['diff','--quiet','HEAD'],{cwd:root})
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean)
assert.deepEqual(untracked.filter(path=>path!=='.cache/pending-'+short+'-environment.json'&&!path.startsWith('.cache/e2e/test-accounts/')),[],'untracked source must be absent; only this private TestPool descriptor/state is allowed')
const url=new URL(process.env.E2E_DATABASE_URL)
assert.ok(['localhost','127.0.0.1'].includes(url.hostname))
const adminUrl=new URL(url);adminUrl.pathname='/postgres'
const name='mikka_pending_'+short+'_e2e'
url.pathname='/'+name
const env={...process.env,E2E_DATABASE_URL:url.href,MIKKA_DATABASE_URL:url.href,DATABASE_URL:url.href,
BETTER_AUTH_URL:'http://localhost:3352',E2E_BASE_URL:'http://localhost:3352',MIKKA_LOCAL_TEST_ACCOUNTS:'1',
MIKKA_TEST_DEPLOYMENT_SHA:sha,MIKKA_TEST_ENVIRONMENT_FILE:root+'/.cache/pending-'+short+'-environment.json'}
for(const key of ['ORVILO_DATABASE_URL','AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPOSIO_API_KEY','E2B_API_KEY','EXPO_ACCESS_TOKEN','POSTHOG_SECRET_KEY','NEXT_PUBLIC_POSTHOG_KEY','RESEND_API_KEY','DEEPSEEK_API_KEY','DEVICE_GATEWAY_URL','DEVICE_GATEWAY_PUSH_SECRET'])delete env[key]
const log=openSync('/tmp/mikka-pending-'+short+'-ui-runtime.log','a',0o600)
async function command(args){const child=spawn(args[0],args.slice(1),{cwd:root,env,stdio:['ignore',log,log]});const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});assert.equal(code,0,'child '+args[0]+' failed')}
try{
 if(process.argv[2]==='prepare'){
  const require=createRequire(root+'/package.json'),{Pool}=require('pg')
  const db=new Pool({connectionString:adminUrl.href,max:1})
  try{assert.equal((await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0,'fresh DB required')
   const role=decodeURIComponent(url.username);assert.match(role,/^[a-z_][a-z0-9_]*$/)
   await db.query('CREATE DATABASE "'+name+'" OWNER "'+role+'"')
  }finally{await db.end()}
  await mkdir(root+'/.cache',{recursive:true})
  await command(['node','--import','tsx','scripts/setup-e2e-db.mjs'])
  await command(['node','scripts/test-accounts/bootstrap.mjs','--output',env.MIKKA_TEST_ENVIRONMENT_FILE])
  await command(['npx','--yes','pnpm@10.34.3','build'])
  const serverLog=openSync('/tmp/mikka-pending-'+short+'-ui-server.log','a',0o600)
  const child=spawn('node',['node_modules/next/dist/bin/next','start','--hostname','localhost','--port','3352'],{cwd:root,env,detached:true,stdio:['ignore',serverLog,serverLog]})
  child.unref();await writeFile('/tmp/mikka-pending-'+short+'-ui-server.pid',String(child.pid),{mode:0o600});closeSync(serverLog)
  console.log(JSON.stringify({status:'prepared',sha,database:name,origin:env.BETTER_AUTH_URL,pid:child.pid}))
 }else if(process.argv[2]==='capture'){
  const descriptor=JSON.parse(await readFile(env.MIKKA_TEST_ENVIRONMENT_FILE,'utf8'))
  assert.equal(descriptor.deploymentSha,sha);assert.equal(descriptor.database.name,name);assert.equal(descriptor.origin,env.BETTER_AUTH_URL)
  const response=await fetch(env.BETTER_AUTH_URL+'/mikka/api/version');assert.equal(response.status,200);assert.equal((await response.json()).build,sha)
  await command(['node','--import','./scripts/server-test.mjs','--import','tsx',root.slice(0, root.lastIndexOf('/'))+'/mikka-pending-capture.mjs'])
  const manifest=JSON.parse(await readFile('/tmp/mikka-pending-'+short+'-screenshots/manifest.json','utf8'))
  console.log(JSON.stringify({status:'captured',sha,captures:manifest.captures.length,finishedAt:manifest.finishedAt}))
 }else throw Error('phase_required')
}finally{closeSync(log)}
