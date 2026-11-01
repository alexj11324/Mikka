import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import * as provider from './e2b-provider'

type Actor={userId:string;workspaceId:string}
type Runtime=Pick<typeof provider,'createComputer'|'connectComputer'|'installComputerRuntime'>&Partial<Pick<typeof provider,'computerGone'|'computerWorkerSha'|'killComputer'>>
// Runs that live on the machine's worker; a run still queued starts on whichever worker is there.
const LIVE_RUNS=['preparing','running','paused','waiting_input','finishing']
/** Reserve an owned machine durably, release SQL locks, then call the provider.
 * Provider idempotency uses the persisted operationId across process loss.
 * The provision lease is not the daemon/worker lease or a permission grant. */
export async function ensureCloudMachine(pool:Pool,actor:Actor,runtime:Runtime=provider) {
  const client=await pool.connect(),leaseId=randomUUID()
  let machine:{sandboxId:string|null;operationId:string;runtimeReady:boolean;state:string}|undefined
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId") VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.workspaceId,actor.userId,randomUUID()])
    const row=(await client.query(`SELECT * FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 FOR UPDATE`,[actor.workspaceId,actor.userId])).rows[0]
    if(row.provisionLeaseUntil && new Date(row.provisionLeaseUntil).getTime()>Date.now()) {await client.query('COMMIT');return null}
    machine=row
    await client.query(`UPDATE cloud_machines SET "provisionLeaseId"=$3,"provisionLeaseUntil"=now()+interval '3 minutes',state='waking' WHERE "workspaceId"=$1 AND "ownerId"=$2`,[actor.workspaceId,actor.userId,leaseId])
    await client.query('COMMIT')
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  if(!machine) throw new Error('Owned cloud machine unavailable')
  try {
    let sandbox=machine.sandboxId?await runtime.connectComputer(actor.workspaceId,machine.sandboxId).catch(error=>{if(runtime.computerGone?.(error)) return null;throw error}):null
    if(machine.sandboxId&&(!sandbox||await stale(pool,actor,sandbox,runtime))) {
      // Gone at E2B, or built from a worker commit production no longer runs (every template
      // release): start over on the current template. The old desktop and files go with it.
      if(sandbox) await runtime.killComputer?.(actor.workspaceId,machine.sandboxId)
      const operationId=randomUUID()
      const replaced=await pool.query(`UPDATE cloud_machines SET "sandboxId"=NULL,"runtimeReady"=false,"operationId"=$5 WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "provisionLeaseId"=$3 AND "sandboxId"=$4`,[actor.workspaceId,actor.userId,leaseId,machine.sandboxId,operationId])
      if(!replaced.rowCount) return null
      machine={...machine,sandboxId:null,operationId,runtimeReady:false}
      sandbox=null
    }
    sandbox??=await runtime.createComputer(actor.workspaceId,machine.operationId)
    // Record even an older attempt's idempotent allocation, but never replace a
    // different machine. A failed later step cannot erase an allocated resource.
    const recorded=await pool.query(`UPDATE cloud_machines SET "sandboxId"=$3 WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "operationId"=$4 AND ("sandboxId" IS NULL OR "sandboxId"=$3) RETURNING "provisionLeaseId"`,[actor.workspaceId,actor.userId,sandbox.sandboxId,machine.operationId])
    if(recorded.rows[0]?.provisionLeaseId!==leaseId) return null
    if(!machine.runtimeReady) await runtime.installComputerRuntime(sandbox)
    const completed=await pool.query(`UPDATE cloud_machines SET state='running',"runtimeReady"=true,"lastActiveAt"=now(),"provisionLeaseId"=NULL,"provisionLeaseUntil"=NULL WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "provisionLeaseId"=$3 AND "sandboxId"=$4 RETURNING "sandboxId"`,[actor.workspaceId,actor.userId,leaseId,sandbox.sandboxId])
    return completed.rowCount?sandbox:null
  } catch(error) {
    await pool.query(`UPDATE cloud_machines SET state='error',"provisionLeaseId"=NULL,"provisionLeaseUntil"=NULL WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "provisionLeaseId"=$3`,[actor.workspaceId,actor.userId,leaseId])
    throw error
  }
}

/** Built from another worker commit, and no live run is using its worker. */
async function stale(pool:Pool,actor:Actor,sandbox:Awaited<ReturnType<Runtime['connectComputer']>>,runtime:Runtime) {
  const expected=process.env.MIKKA_CLOUD_WORKER_SHA
  if(!expected||!runtime.computerWorkerSha||!runtime.killComputer) return false
  if(await runtime.computerWorkerSha(sandbox)===expected) return false
  const live=await pool.query(`SELECT 1 FROM agent_runs r WHERE r."userId"=$1 AND r.status=ANY($3::text[]) AND (
    r."deviceId"=(SELECT "deviceId" FROM cloud_machines WHERE "workspaceId"=$2 AND "ownerId"=$1)
    OR EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=$1 AND b."workspaceId"=$2 AND NOT EXISTS(SELECT 1 FROM thread_machines t WHERE t."runId"=r.id))) LIMIT 1`,[actor.userId,actor.workspaceId,LIVE_RUNS])
  return !live.rowCount
}
