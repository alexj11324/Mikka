#!/usr/bin/env node
// Frozen three-DB scope acceptance. --plan never imports pg, runs a child or SQL.
import { readFileSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SCOPE_DATABASES, SCOPE_LIMITS, scopeUrl, checkedScopeUrl, scopePolicy, controlledChild } from './scope-acceptance-policy.mjs'
import { SCOPE_IDENTITY_SQL } from './scope-acceptance-runtime.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')
export function verifyScopeManifest(manifest, read = readFileSync) {
  if (manifest.migrations.length !== 70 || manifest.sources.length < 10) throw Error('scope manifest inventory mismatch')
  for (const file of [...manifest.sources, ...manifest.migrations]) if (digest(read(file.path)) !== file.sha256) throw Error('scope source/hash mismatch: ' + file.path)
  if (new Set(manifest.migrations.map(file => file.path)).size !== 70 || manifest.migrations.filter(file => file.target === 'DATABASE_URL').length !== 7) throw Error('scope migration targets mismatch')
}
export function scopeWorkerMode(mode) {
  if(!['suite','migrate'].includes(mode))throw Error('scope worker mode mismatch')
  return {MIGRATE:mode==='migrate'?'1':'0',VERCEL_ENV:''}
}
export async function scopePhases(run) { for(const phase of ['scope','team'])await run(phase) }
async function execute(manifest, manifestPath, manifestHash, output, approvalReference, started) {
  if(approvalReference&&Buffer.byteLength(approvalReference)>256)throw Error('scope approval reference too long')
  if (!approvalReference) throw Error('scope execution needs separately granted approval reference; this flag is not approval')
  if(resolve(output)!==manifest.evidenceDirectory)throw Error('scope evidence directory mismatch')
  if (Object.keys(process.env).some(key => key.startsWith('PG') && process.env[key])) throw Error('ambient PG configuration is not permitted')
  const inspection = JSON.parse(execFileSync('docker', ['inspect','--format','{"id":"{{.Id}}","running":{{.State.Running}},"image":"{{.Image}}","mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}','mikka-issue184-pg'], { encoding: 'utf8', timeout:5000 }))
  if (inspection.id !== manifest.resource.id || inspection.image !== manifest.resource.image || !inspection.running || !inspection.mounts.some(mount => mount.Name === manifest.resource.volume && mount.Destination === '/var/lib/postgresql/data') || inspection.ports['5432/tcp']?.[0]?.HostIp !== '127.0.0.1' || inspection.ports['5432/tcp']?.[0]?.HostPort !== '55484') throw Error('original scope server not running or identity changed; no start/replacement is authorized')
  // Native module import constructs no client/connection and precedes owned timers.
  const pg = (await import('pg')).default
  mkdirSync(output, { mode: 0o700 })
  const claim = openSync(resolve(output,'execution.claim'), 'wx', 0o600)
  writeSync(claim, JSON.stringify({ candidate: manifest.candidate, manifestHash, approvalReference, started: new Date().toISOString() }));closeSync(claim)
  const journal = openSync(resolve(output,'journal.jsonl'),'wx',0o600)
  let journalBytes = 0, rootQueries = 0, journalFull = false
  function record(entry) {
    if(journalFull)return
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    journalBytes += Buffer.byteLength(line)
    if(journalBytes>SCOPE_LIMITS.journalBytes-4096){journalFull=true;writeSync(journal,'{"event":"journal-budget-exhausted"}\n');throw Error('scope journal budget exhausted')}
    writeSync(journal,line)
  }
  const executionDeadline=started+SCOPE_LIMITS.totalMs
  let readDeadline=executionDeadline
  const controller = new AbortController(), policy = scopePolicy(manifest.migrations,record)
  const all = new Set(), ended = new Set()
  let failed
  const abort = error => { if(!failed){failed=error;policy.abort(error.message);controller.abort()} }
  const hardStop=setTimeout(()=>{
    for(const worker of all)worker.kill('SIGKILL')
    try{record({event:'hard-stop',pendingQueries:[...policy.state.pending.keys()],outcomesMayBeUnknown:true})}catch{}
    process.exit(1)
  },Math.max(1,started+SCOPE_LIMITS.totalMs+30000-Date.now()))
  const timer = setTimeout(() => abort(Error('scope acceptance total timeout')), Math.max(1,executionDeadline-Date.now()))
  const poolOptions = database => ({ connectionString: scopeUrl(database), max:1, statement_timeout:1000, lock_timeout:1000, idle_in_transaction_session_timeout:3000, connectionTimeoutMillis:1000, query_timeout:1500 })
  const admin = new pg.Pool(poolOptions('issue184_e2e'))
  async function read(pool,text,values) {
    if (++rootQueries > SCOPE_LIMITS.rootQueries) throw Error('scope readback query budget exhausted')
    if(Date.now()>=readDeadline)throw Error('scope readback deadline exhausted')
    const answer = await pool.query({text,values,query_timeout:Math.max(1,Math.min(1500,readDeadline-Date.now()))})
    record({ event:'root-read', sqlSha256:digest(text), rowCount:answer.rowCount })
    return answer.rows
  }
  async function inspectNew(database) {
    const [row] = await read(admin,'select oid::text as oid, pg_get_userbyid(datdba) as owner from pg_database where datname=$1',[database])
    if (!row || row.owner !== 'postgres') throw Error('new database ownership unknown')
    return row.oid
  }
  async function snapshot(database,stage) {
    const owned = policy.state.created.get(database)
    if (!owned || await inspectNew(database) !== owned) throw Error('readback ownership mismatch')
    const pool = new pg.Pool(poolOptions(database))
    try {
      const [identity] = await read(pool,SCOPE_IDENTITY_SQL)
      if (identity.oid !== owned || identity.role !== 'postgres') throw Error('readback identity mismatch')
      const tables = await read(pool,"select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname")
      if (tables.length > SCOPE_LIMITS.snapshotTables) throw Error('scope snapshot table budget exceeded')
      const quoted = name => '"' + name.replaceAll('"','""') + '"'
      const counts = tables.length ? await read(pool,tables.map(({name}) => `select '${name.replaceAll("'","''")}'::text as name, count(*)::int as rows from public.${quoted(name)}`).join(' union all ')) : []
      if(counts.some(row=>row.name==='schema_migrations')){
        const ledger=await read(pool,'select name from schema_migrations order by name')
        const expected=manifest.migrations.filter(file=>database===SCOPE_DATABASES.scope||(database===SCOPE_DATABASES.workspace?file.target==='DATABASE_URL':file.target!=='DATABASE_URL')).map(file=>file.path.split('/').at(-1)).sort()
        if(stage!=='failure-readback'&&JSON.stringify(ledger.map(row=>row.name))!==JSON.stringify(expected))throw Error('fresh scope ledger mismatch')
        record({event:'ledger-readback',database,stage,count:ledger.length,sha256:digest(JSON.stringify(ledger))})
      }
      const stats = await read(pool,"select relname,n_tup_ins,n_tup_upd,n_tup_del from pg_stat_user_tables order by relname")
      record({event:'snapshot',database,stage,counts,stats,statsMeaning:'server counters include rollbacks and may lag; exact row counts are net committed state, not gross trigger/cascade effects'})
      if (counts.reduce((sum,row)=>sum+row.rows,0) > SCOPE_LIMITS.snapshotLiveRows) throw Error('scope post-boundary live-row threshold exceeded; this does not bound prior trigger effects')
    } finally { await pool.end() }
  }
  const baseEnv = { PATH:process.env.PATH, HOME:'/workspace', LANG:'C.UTF-8', TSX_DISABLE_CACHE:'1', NODE_DISABLE_COMPILE_CACHE:'1', NODE_ENV:'development', ISSUE184_LOCAL_TEST:'1', REQUIRE_DB:'1', MIGRATE:'0', VERCEL_ENV:'', NEXT_TELEMETRY_DISABLED:'1', BETTER_AUTH_URL:'http://127.0.0.1:3100', SCOPE_ACCEPTANCE_MANIFEST:manifestPath, SCOPE_ACCEPTANCE_MANIFEST_SHA256:manifestHash }
  async function child(phase,mode,databases) {
    policy.active()
    const stdout = [], stderr = []
    const log = openSync(resolve(output,phase+(mode==='migrate'?'-migrate':'-suite')+'.log'),'wx',0o600)
    const worker = fork(resolve('scripts/scope-acceptance-worker.mjs'), [], { execArgv:['--import',resolve('scripts/server-test.mjs'),'--import','tsx'], env:{ ...baseEnv, ...scopeWorkerMode(mode), SCOPE_ACCEPTANCE_PHASE:phase,SCOPE_ACCEPTANCE_MODE:mode,E2E_DATABASE_URL:scopeUrl('issue184_e2e'),MIKKA_DATABASE_URL:databases.app,DATABASE_URL:databases.workspace }, stdio:['ignore','pipe','pipe','ipc'] })
    all.add(worker)
    try {
      await controlledChild(worker,{ timeoutMs:mode==='migrate'?SCOPE_LIMITS.migrationMs:SCOPE_LIMITS.phaseMs,signal:controller.signal,
        onOutput(chunk,error){writeSync(log,chunk);(error?stderr:stdout).push(Buffer.from(chunk))},
        async onMessage(message,target){
          try {
            const {kind,input}=message
            let value
            if(kind==='connect') {
              if(input.bucket!==phase+(mode==='migrate'?':migrate':''))throw Error('connection bucket mismatch')
              policy.connect(input.bucket,input)
            } else if(kind==='query') {
              if(input.bucket!==phase+(mode==='migrate'?':migrate':''))throw Error('query bucket mismatch')
              value=policy.grant(input.bucket,input)
            } else if(kind==='cleanup') {
              if(input.bucket!==phase+(mode==='migrate'?':migrate':''))throw Error('cleanup bucket mismatch')
              value=policy.cleanup(input.bucket,input)
            } else if(kind==='query-result') {
              const query=policy.result(input.id,input)
              if(input.identity&&input.ok) {
                const expected=query.database==='issue184_e2e'?adminIdentity.oid:policy.state.created.get(query.database)
                if(input.identity.oid!==expected||input.identity.role!=='postgres'||input.identity.database!==query.database)throw Error('worker connection identity mismatch')
              }
              if(query.create&&input.ok)policy.state.created.set(query.create,await inspectNew(query.create))
            } else if(kind==='migrate') {
              if(mode==='migrate')throw Error('nested migration denied')
              checkedScopeUrl(input.app,phase);checkedScopeUrl(input.workspace,phase)
              const expected=phase==='scope'?{app:scopeUrl(SCOPE_DATABASES.scope),workspace:scopeUrl(SCOPE_DATABASES.scope)}:{app:scopeUrl(SCOPE_DATABASES.app),workspace:scopeUrl(SCOPE_DATABASES.workspace)}
              if(input.app!==expected.app||input.workspace!==expected.workspace)throw Error('migration child target mismatch')
              policy.migrationCall(phase);value=await child(phase,'migrate',expected);policy.migrated(phase)
              for(const db of new Set(Object.values(expected).map(url=>new URL(url).pathname.slice(1))))await snapshot(db,'after-migration')
            } else if(kind==='failure') { throw Error('scope test failed') }
            else if(kind==='finished') { ended.add(phase+':'+mode);record({event:'worker-finished',phase,mode,...input}) }
            else throw Error('unknown scope RPC')
            if(target.connected)target.send({id:message.id,value})
          } catch(error) {
            record({event:'rpc-denied-or-failed',phase,mode,kind:message.kind,reason:error.message})
            if(target.connected)target.send({id:message.id,error:error.message})
            abort(error)
          }
        },
      })
      if(!ended.has(phase+':'+mode))throw Error('scope worker missing final resource record')
      return {stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}
    } catch(error) { abort(error);throw error }
    finally { all.delete(worker);closeSync(log) }
  }
  let adminIdentity
  try {
    ;[adminIdentity]=await read(admin,SCOPE_IDENTITY_SQL)
    if(adminIdentity?.role!=='postgres'||adminIdentity.database!=='issue184_e2e')throw Error('original admin identity mismatch')
    const existing=await read(admin,'select datname from pg_database where datname=any($1::text[])',[Object.values(SCOPE_DATABASES)])
    if(existing.length)throw Error('scope database already exists; never reuse')
    record({event:'preflight',resource:{id:manifest.resource.id,image:manifest.resource.image,volume:manifest.resource.volume},adminIdentity,targetsAbsent:Object.values(SCOPE_DATABASES)})
    await scopePhases(async phase=>{
      await child(phase,'suite',{app:scopeUrl('issue184_e2e'),workspace:scopeUrl('issue184_e2e')})
      for(const database of phase==='scope'?[SCOPE_DATABASES.scope]:[SCOPE_DATABASES.app,SCOPE_DATABASES.workspace])await snapshot(database,'after-suite')
    })
    if(policy.state.migrationCalls.size!==2||policy.state.replays.size!==3||policy.state.pending.size)throw Error('scope final execution count mismatch')
    record({event:'success',queryCounts:policy.state.counts,rootQueries,databases:[...policy.state.created],migrationFiles:policy.state.migrations.size,replays:policy.state.replays.size})
  } catch(error) {
    abort(error)
    readDeadline=Date.now()+15000
    record({event:'failure',reason:error.message,pendingQueries:[...policy.state.pending.keys()],created:[...policy.state.created]})
    for(const database of journalFull?[]:policy.state.created.keys()) {try{await snapshot(database,'failure-readback')}catch(readError){record({event:'readback-failed',database,reason:readError.message})}}
    // CREATE response loss permits metadata readback only, never inferred DB ownership.
    try{if(!journalFull)record({event:'attempted-db-catalog',rows:await read(admin,'select datname,oid::text,pg_get_userbyid(datdba) as owner from pg_database where datname=any($1::text[])',[[...policy.state.createAttempts]])})}catch{record({event:'catalog-readback-unavailable'})}
    throw error
  } finally {
    clearTimeout(timer);controller.abort()
    for(const worker of all)worker.kill('SIGTERM')
    await admin.end();record({event:'stopped',failed:Boolean(failed),rootQueries,retained:true});
    writeFileSync(resolve(output,'result.json'),JSON.stringify({candidate:manifest.candidate,manifestHash,failed:Boolean(failed),reason:failed?.message,queryCounts:policy.state.counts,rootQueries,created:[...policy.state.created],pendingCount:policy.state.pending.size,pendingIds:[...policy.state.pending.keys()].slice(0,64),journalFull,retained:true,outcomesMayBeUnknown:Boolean(failed)})+'\n',{flag:'wx',mode:0o600});closeSync(journal);clearTimeout(hardStop)
  }
}
export async function main(args=process.argv.slice(2)) {
  const started=Date.now()
  const [mode,manifestInput,expectedHash,approvalReference,output]=args
  if(!['--plan','--run'].includes(mode)||!manifestInput||!expectedHash)throw Error('usage: --plan|--run manifest sha256 [approval-reference output-new-directory]')
  const manifestPath=resolve(manifestInput),bytes=readFileSync(manifestPath)
  if(digest(bytes)!==expectedHash)throw Error('scope manifest SHA mismatch')
  const manifest=JSON.parse(bytes);verifyScopeManifest(manifest)
  if(process.versions.node!==manifest.nodeVersion)throw Error('scope Node version mismatch')
  const git=(...argv)=>execFileSync('git',argv,{encoding:'utf8',timeout:5000}).trim()
  if(git('rev-parse','HEAD')!==manifest.candidate||git('rev-parse','HEAD^{tree}')!==manifest.tree||git('status','--porcelain'))throw Error('scope candidate/worktree mismatch')
  if(mode==='--plan'){console.log(JSON.stringify({candidate:manifest.candidate,manifestHash:expectedHash,limits:SCOPE_LIMITS,databases:SCOPE_DATABASES,executed:false}));return}
  if(!output)throw Error('scope requires a new retained evidence directory')
  await execute(manifest,manifestPath,expectedHash,resolve(output),approvalReference,started)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1})
