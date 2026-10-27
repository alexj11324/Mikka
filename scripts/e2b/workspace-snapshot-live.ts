import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { prepareWorkspaceSnapshot,collectRetiredSnapshots } from '../../lib/computer/workspace-snapshot'
import { ThreadMachines } from '../../lib/computer/thread-machine'
import { threadMachineProvider } from '../../lib/computer/e2b-provider'
import { preserveThreadResult } from '../../lib/computer/thread-result'
import { threadResultDownload } from '../../lib/computer/thread-result-download'

async function main() {
const url=process.env.COMPUTER_TEST_DATABASE_URL!;if(!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Loopback database required')
const opts={apiKey:process.env.E2B_API_KEY!,proxy:process.env.HTTPS_PROXY,timeoutMs:240000}
const schema='snapshotlive_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`)
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});let source:Sandbox|undefined,child:string|undefined,resultSnapshot:string|null=null,restored:Sandbox|undefined
try{
 await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('synthetic'); CREATE TABLE bots (id uuid,"workspaceId" uuid,"ownerId" text,UNIQUE(id,"workspaceId","ownerId")); CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"agentId" uuid,status text,"stopRequestedAt" timestamptz,"startedAt" timestamptz,"worktreePath" text); CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid,"workspaceId" uuid,"ownerId" text); CREATE TABLE devices (id uuid PRIMARY KEY); CREATE TABLE cloud_machines ("workspaceId" uuid,"ownerId" text,"sandboxId" text,state text); CREATE TABLE workspace_computer_policies ("workspaceId" uuid,permission text); CREATE TABLE bot_cloud_runtimes ("botId" uuid,"workspaceId" uuid,"ownerId" text,"agentId" uuid,"repoId" uuid); CREATE TABLE device_repos (id uuid,"userId" text,"repoPath" text)`)
 await pool.query(await readFile('drizzle/20261027180000_thread_machines_and_bot_subagents.sql','utf8'));await pool.query(await readFile('drizzle/20261027180003_workspace_snapshot_versions.sql','utf8'));await pool.query(await readFile('drizzle/20261027180004_thread_results.sql','utf8'))
 const actor={userId:'synthetic',workspaceId:randomUUID()},botId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),runId=randomUUID(),run2=randomUUID(),path=`/home/mikka-runner/.mikka/bot-workspaces/${botId}`
 source=await Sandbox.create(process.env.E2B_COMPUTER_TEMPLATE!,opts)
 const sha=(await source.files.read('/opt/mikka/worker-source-sha',{user:'root'})).trim()
 process.env.MIKKA_CLOUD_WORKER_SHA=sha
 await source.commands.run(`install -d -o mikka-runner -g mikka-runner -m 0700 ${path}`,{user:'root'})
 await source.commands.run(`git -C ${path} init -q -b main; printf 'fixture-one\n' > ${path}/fixture.txt; printf 'deps-one\n' > ${path}/pnpm-lock.yaml; git -C ${path} add .; git -C ${path} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture`,{user:'mikka-runner',timeoutMs:30000})
 await pool.query('INSERT INTO bots VALUES ($1,$2,$3)',[botId,actor.workspaceId,actor.userId]);await pool.query('INSERT INTO cloud_machines VALUES ($1,$2,$3,$4)',[actor.workspaceId,actor.userId,source.sandboxId,'running']);await pool.query('INSERT INTO device_repos VALUES ($1,$2,$3)',[repoId,actor.userId,path]);await pool.query('INSERT INTO bot_cloud_runtimes VALUES ($1,$2,$3,$4,$5)',[botId,actor.workspaceId,actor.userId,agentId,repoId])
 for(const id of [runId,run2]){await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,$4)',[id,actor.userId,agentId,'queued']);await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)',[id,botId,actor.workspaceId,actor.userId])}
 const snap=await prepareWorkspaceSnapshot(pool,actor,runId,botId,sha);const machines=new ThreadMachines(pool,threadMachineProvider);child=await machines.wake(actor,runId)
 const instance=await Sandbox.connect(child,opts);if((await instance.files.read('/workspace/fixture.txt',{user:'mikka-runner'})).trim()!=='fixture-one')throw Error('workspace fixture missing')
 const worktree=`/home/mikka-runner/.mikka/worker/worktrees/${runId}`
 await instance.commands.run(`mkdir -p /home/mikka-runner/.mikka/worker/worktrees; git -C /workspace worktree add -b mikka/run-${runId} ${worktree} main >/dev/null; printf 'uncommitted fixture\n' > ${worktree}/uncommitted.txt`,{user:'mikka-runner',timeoutMs:30000})
 await source.commands.run(`printf 'deps-two\n' > ${path}/pnpm-lock.yaml`,{user:'mikka-runner'})
 const refreshed=await prepareWorkspaceSnapshot(pool,actor,run2,botId,sha);if(snap===refreshed)throw Error('snapshot not refreshed')
 await collectRetiredSnapshots(pool,actor);const retained=await pool.query('SELECT 1 FROM workspace_snapshot_versions WHERE "snapshotId"=$1',[snap]);if(!retained.rowCount)throw Error('live snapshot deleted')
 await pool.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"worktreePath"=$3 WHERE id=$1',[runId,'succeeded',worktree])
 resultSnapshot=await preserveThreadResult(pool,actor,runId);if(!resultSnapshot)throw Error('result snapshot missing')
 restored=await Sandbox.create(resultSnapshot,opts)
 if((await restored.files.read(`${worktree}/uncommitted.txt`,{user:'mikka-runner'})).trim()!=='uncommitted fixture')throw Error('uncommitted work missing')
 await restored.commands.run(`git -C ${worktree} rev-parse --verify HEAD >/dev/null; test ! -e /home/mikka-runner/.mikka/worker/device.json`,{user:'mikka-runner',timeoutMs:30000})
 await machines.end(actor,runId);child=undefined
 if(await threadResultDownload(pool,{...actor,userId:'other'},runId))throw Error('foreign result was accessible')
 const download=await threadResultDownload(pool,actor,runId);if(!download)throw Error('result download unavailable')
 const tar=gunzipSync(Buffer.from(await new Response(download).arrayBuffer()));if(!tar.includes(Buffer.from('uncommitted fixture'))||!tar.includes(Buffer.from('workspace/fixture.txt')))throw Error('result archive is incomplete')
 await collectRetiredSnapshots(pool,actor);const removed=await pool.query('SELECT 1 FROM workspace_snapshot_versions WHERE "snapshotId"=$1',[snap]);if(removed.rowCount)throw Error('retired snapshot retained')
 console.log('live snapshot: workspace refresh, result preservation, download and cleanup passed')
}finally{
 if(child)await Sandbox.kill(child,opts).catch(()=>console.log('child_cleanup_failed'))
 if(restored)await restored.kill().catch(()=>console.log('restore_cleanup_failed'))
 if(resultSnapshot)await Sandbox.deleteSnapshot(resultSnapshot,opts).catch(()=>console.log('result_cleanup_failed'))
 if(source)await source.kill().catch(()=>console.log('source_cleanup_failed'))
 const snaps=await pool.query('SELECT "snapshotId" FROM workspace_snapshot_versions').catch(()=>({rows:[]}));for(const s of snaps.rows)await Sandbox.deleteSnapshot(s.snapshotId,opts).catch(()=>console.log('snapshot_cleanup_failed'))
 await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()
}

}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Live test failed"); process.exitCode = 1 })
