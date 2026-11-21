import 'server-only'
import { lockSubagentEvents, notifySubagentEvents } from '@/lib/computer/event-log'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { BrowserCaller } from '@/lib/credentials/contracts'
import type { BrowserTarget } from '@/lib/credentials/store'
import { SubagentStore } from './subagents'
import { credentialPlanDigest, credentialPlanSchema, credentialReviewSummary, type CredentialPlan } from './credential-plan'
import { wakeTokens, wakeWorkflowSoon } from '@/lib/workflow-wake'

/** Reuse an explicit saved-account login for the exact owner and origin. A saved
 * login is the consent: the broker's one-time lease and page-binding recheck are
 * the only gates; no model assertion grants permission, and revoking the saved
 * login is the only deny. */
export async function proposeCredentialOperation(pool: Pool, caller: BrowserCaller, target: BrowserTarget, options: { submittedUsername?: string; forcePassword?: boolean } = {}) {
  if (!caller.subagentId || caller.runId || !target.observedInputs?.length) throw new Error('Credential target unavailable')
  const observed = target.observedInputs[0]
  if (target.observedInputs.some(item => item.loaderId !== observed.loaderId || item.epoch !== observed.epoch || item.permissionVersion !== observed.permissionVersion)) throw new Error('Credential target unavailable')
  let plan = credentialPlanSchema.parse({ actionId: randomUUID(), workspaceId: caller.workspaceId, botId: caller.botId, subagentId: caller.subagentId, epoch: observed.epoch, permissionVersion: observed.permissionVersion, targetId: target.targetId, origin: target.origin, loaderId: observed.loaderId, inputs: target.observedInputs.map(({ backendNodeId, credentialRole }) => ({ backendNodeId, credentialRole })), operation: 'login', summary: credentialReviewSummary(target.origin), expiresAt: Date.now() + 5 * 60_000, ...options })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${caller.workspaceId}`])
    const policy=(await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE',[caller.workspaceId])).rows[0]
    if(policy?.permission==='deny' || Number(policy?.version ?? 0)!==plan.permissionVersion) throw new Error('Credential policy changed')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credentials:${caller.userId}:${plan.origin}`])
    const credentials=await client.query(`SELECT c.id,s.nonce FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.user_id=$1 AND c.origin=$2 AND c.revoked_at IS NULL AND ($3::text IS NULL OR c.username=$3) ORDER BY c.id LIMIT 2 FOR SHARE OF c,s`,[caller.userId,plan.origin,options.submittedUsername ?? null])
    if(credentials.rows.length!==1) {await client.query('COMMIT');return {status:'needs_login' as const,origin:plan.origin}}
    plan=credentialPlanSchema.parse({...plan,credentialId:credentials.rows[0].id,credentialRevision:credentials.rows[0].nonce})
    const row = (await client.query(`SELECT status,epoch,needs,"targetId","activeActionId" FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 FOR UPDATE`, [plan.subagentId, caller.userId, plan.workspaceId, plan.botId])).rows[0]
    if (!row || !['running','needs_you'].includes(row.status) || Number(row.epoch) !== plan.epoch || row.targetId !== plan.targetId) throw new Error('Credential target unavailable')
    if(row.activeActionId) {
      const active=(await client.query(`SELECT status FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR SHARE`,[row.activeActionId,caller.userId])).rows[0]
      if(active?.status==='running') throw new Error('browserActionOutcomeUnknown')
    }
    if (row.needs?.kind === 'approval') {
      const pending = await client.query(`SELECT id FROM pending_actions WHERE id=$1 AND "userId"=$2 AND status='pending' AND "createdAt">now()-interval '5 minutes'`, [row.needs.actionId, caller.userId])
      if (pending.rowCount) { await client.query('COMMIT'); return { status: 'needs_approval' as const, origin: target.origin } }
    }
    // The pending_actions row is the durable receipt for this sign-in: it pins
    // the exact plan the owner saved consent for and makes a replay or a forged
    // plan fail closed, without ever appearing as an approval card.
    await client.query(`INSERT INTO pending_actions(id,"userId","botId",action,input,status) VALUES($1,$2,$4,'credential_operation',$3,'running')`, [plan.actionId, caller.userId, JSON.stringify({ ...plan, digest: credentialPlanDigest(caller.userId, plan) }), plan.botId])
    await lockSubagentEvents(client, { ownerId: caller.userId, workspaceId: caller.workspaceId })
    await client.query(`WITH changed AS (UPDATE bot_subagents SET status='running',step='Signing in',needs=NULL,"activeActionId"=$5 WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 RETURNING *) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event) SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`, [plan.subagentId, caller.userId, plan.workspaceId, plan.botId, plan.actionId])
    await client.query('COMMIT')
    notifySubagentEvents({ ownerId: caller.userId, workspaceId: caller.workspaceId })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const raw={...plan,digest:credentialPlanDigest(caller.userId,plan)}
  const outcome=await executeCredentialOperation(pool,caller.userId,raw)
  if('error' in outcome) throw new Error(outcome.error)
  return {status:String(outcome.data.status ?? 'guarded'),origin:target.origin}
}

export async function executeCredentialOperation(pool: Pool, userId: string, raw: unknown): Promise<{ data: Record<string, unknown> } | { error: string }> {
  try { return await executeCredential(pool, userId, raw) }
  finally {
    // The login decision changed the web task's row: its workflow continues now (#1212).
    const subagentId = z.object({ subagentId: z.uuid() }).safeParse(raw).data?.subagentId
    if (subagentId) wakeWorkflowSoon(wakeTokens.subagent(subagentId))
  }
}
async function executeCredential(pool: Pool, userId: string, raw: unknown): Promise<{ data: Record<string, unknown> } | { error: string }> {
  let plan: CredentialPlan | undefined
  let bound=false
  try {
    const envelope = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(raw)
    const { digest, ...rest } = envelope
    plan = credentialPlanSchema.parse(rest)
    if (credentialPlanDigest(userId, plan) !== digest || plan.expiresAt <= Date.now()) return { error: 'browserActionExpired' }
    const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId, plan.workspaceId)
    // Defense in depth: direct calls cannot bypass the atomic owner decision.
    const ledger = await pool.query(`SELECT 1 FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action='credential_operation' AND status='running' AND input=$3::jsonb AND "createdAt">now()-interval '5 minutes'`, [plan.actionId, userId, JSON.stringify(raw)])
    if (!ledger.rowCount) return { error: 'browserActionExpired' }
    bound=true
    if(!plan.credentialId || !plan.credentialRevision) return {error:'credentialGrantRevoked'}
    const actor = { userId, workspaceId: plan.workspaceId }, store = new SubagentStore(pool)
    const row = await store.get(actor, plan.botId, plan.subagentId)
    if (row.status!=='running' || row.activeActionId!==plan.actionId || Number(row.epoch) !== plan.epoch || row.targetId !== plan.targetId) return { error: 'browserActionExpired' }
    const caller = { ...actor, botId: plan.botId, subagentId: plan.subagentId }
    const { credentialStore, executeCredentialLease } = await import('@/lib/credentials/runtime')
    await credentialStore.authorize(caller)
    const target: BrowserTarget = { targetId: plan.targetId, origin: plan.origin, endpoint: '', expiresAt: plan.expiresAt, observedInputs: plan.inputs.map(input => ({ ...input, loaderId: plan!.loaderId, epoch: plan!.epoch, permissionVersion: plan!.permissionVersion })) }
    const consent=await pool.query(`SELECT 1 FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND s.nonce=$4`,[plan.credentialId,userId,plan.origin,plan.credentialRevision])
    if(!consent.rowCount) return {error:'credentialGrantRevoked'}
    const claimed=await pool.query(`UPDATE pending_actions SET result=$2 WHERE id=$1 AND status='running' AND result IS NULL RETURNING id`,[plan.actionId,{invocationStarted:true}])
    if(!claimed.rowCount) return {error:'browserActionOutcomeUnknown'}
    const { resolveSubagentBrowserTarget } = await import('./subagent-browser')
    const fresh = await resolveSubagentBrowserTarget(caller)
    if (fresh.targetId !== plan.targetId || fresh.origin !== plan.origin || JSON.stringify(fresh.observedInputs) !== JSON.stringify(target.observedInputs)) return { error: 'browserActionExpired' }
    const lease = await credentialStore.lease(caller, plan.origin, fresh, plan.submittedUsername, plan.forcePassword, {credentialId:plan.credentialId,revision:plan.credentialRevision})
    if (lease.status === 'needs_login') {
      await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1 AND "userId"=$3`,[plan.actionId,{status:'needs_login'},userId])
      await pool.query('UPDATE bot_subagents SET "activeActionId"=NULL WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3',[plan.subagentId,userId,plan.actionId])
      await store.update(actor, plan.botId, plan.subagentId, 'needs_you', 'login unavailable', { kind: 'login', site: plan.origin })
      return { data: { status: 'needs_login' } }
    }
    // Broker itself holds policy+credential locks and rechecks exact version.
    const result = await executeCredentialLease(lease.lease, plan.origin, { ownerId: caller.userId, workspaceId: caller.workspaceId })
    if (result.status !== 'guarded') {
      await store.update(actor,plan.botId,plan.subagentId,'running','Observe login outcome')
      await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1`,[plan.actionId,{status:result.status}])
      return {data:{status:result.status}}
    }
    // The saved-login grant covers one sign-in, not just a fill. Continue to
    // same-document submission without requesting the same consent twice.
    const client = await pool.connect()
    let resumed = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${plan.workspaceId}`])
      const current = (await client.query(`SELECT s.*,m."sandboxId",COALESCE(p.version,0) AS "permissionVersion",p.permission FROM bot_subagents s JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId" AND m.state='running' LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId" WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4 FOR UPDATE OF s`, [plan.subagentId, userId, plan.workspaceId, plan.botId])).rows[0]
      if (!current || !['running','needs_you'].includes(current.status) || current.activeActionId!==plan.actionId || Number(current.epoch) !== plan.epoch || current.targetId !== plan.targetId || current.permission === 'deny' || Number(current.permissionVersion) !== plan.permissionVersion) throw new Error('Credential action expired')
      const consent=await client.query(`SELECT 1 FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND s.nonce=$4 FOR SHARE OF c,s`,[plan.credentialId,userId,plan.origin,plan.credentialRevision])
      if(!consent.rowCount) throw new Error('Credential grant revoked')
      const { connectComputer } = await import('@/lib/computer/e2b-provider')
      const { grant, endpointPath } = await import('./runtime')
      const capability = await grant(await connectComputer(plan.workspaceId, current.sandboxId), current, 'credential-continuation', { actionId: plan.actionId, operation: 'submit', targetId: plan.targetId, origin: plan.origin, loaderId: plan.loaderId, inputs: plan.inputs })
      const response = await fetch(endpointPath(capability.endpoint, '/credentials/continue'), { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000) })
      if (!response.ok) throw new Error('Credential action outcome unknown')
      const result = z.object({ resumed: z.boolean(), operation: z.enum(['submit','clear']) }).strict().parse(await response.json())
      if (result.operation !== 'submit') throw new Error('Credential action outcome unknown')
      resumed = result.resumed
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    if (resumed) await store.update(actor, plan.botId, plan.subagentId, 'running', 'Observe login outcome')
    await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1`,[plan.actionId,{status:resumed?'resumed':'guarded'}])
    // A submit that cannot prove safety stays needs_you; never retry implicitly.
    if (!resumed) {
      await pool.query('UPDATE bot_subagents SET "activeActionId"=NULL WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3',[plan.subagentId,userId,plan.actionId])
      await store.update(actor,plan.botId,plan.subagentId,'needs_you','Login needs additional input',{kind:'login',site:plan.origin})
    }
    return { data: { status: resumed ? 'resumed' : 'guarded' } }
  } catch {
    // Never release the gateway guard on an unknown result or manufacture an
    // authentication result. The consumed ledger prevents an automatic retry.
    if (plan && bound) await new SubagentStore(pool).update({ userId, workspaceId: plan.workspaceId }, plan.botId, plan.subagentId, 'needs_you', 'Credential action outcome unknown', { kind: 'login', site: plan.origin }).catch(() => undefined)
    return { error: 'browserActionOutcomeUnknown' }
  }
}
