import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { BrowserCaller } from '@/lib/credentials/contracts'
import type { BrowserTarget } from '@/lib/credentials/store'
import { SubagentStore } from './subagents'
import { credentialPlanDigest, credentialPlanSchema, credentialReviewSummary, type CredentialPlan } from './credential-plan'

/** Reuse an explicit saved-account unattended-login grant for the exact owner
 * and origin. Historical fill/submit/clear decisions keep their original narrow
 * meaning. No model assertion grants permission; current deny always wins. */
export async function proposeCredentialOperation(pool: Pool, caller: BrowserCaller, target: BrowserTarget, operation: CredentialPlan['operation'], options: { submittedUsername?: string; forcePassword?: boolean } = {}) {
  if (!caller.subagentId || caller.runId || !target.observedInputs?.length) throw new Error('Credential target unavailable')
  const observed = target.observedInputs[0]
  if (target.observedInputs.some(item => item.loaderId !== observed.loaderId || item.epoch !== observed.epoch || item.permissionVersion !== observed.permissionVersion)) throw new Error('Credential target unavailable')
  let plan = credentialPlanSchema.parse({ actionId: randomUUID(), workspaceId: caller.workspaceId, botId: caller.botId, subagentId: caller.subagentId, epoch: observed.epoch, permissionVersion: observed.permissionVersion, targetId: target.targetId, origin: target.origin, loaderId: observed.loaderId, inputs: target.observedInputs.map(({ backendNodeId, credentialRole }) => ({ backendNodeId, credentialRole })), operation, summary: credentialReviewSummary(operation, target.origin), expiresAt: Date.now() + 5 * 60_000, ...options })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${caller.workspaceId}`])
    const policy=(await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE',[caller.workspaceId])).rows[0]
    if(policy?.permission==='deny' || Number(policy?.version ?? 0)!==plan.permissionVersion) throw new Error('Credential policy changed')
    if(operation==='login') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credentials:${caller.userId}:${plan.origin}`])
      const credentials=await client.query(`SELECT c.id,s.nonce FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.user_id=$1 AND c.origin=$2 AND c.revoked_at IS NULL AND c.unattended_allowed=true AND ($3::text IS NULL OR c.username=$3) ORDER BY c.id LIMIT 2 FOR SHARE OF c,s`,[caller.userId,plan.origin,options.submittedUsername ?? null])
      if(credentials.rows.length!==1) {await client.query('COMMIT');return {status:'needs_login' as const,origin:plan.origin}}
      plan=credentialPlanSchema.parse({...plan,credentialId:credentials.rows[0].id,credentialRevision:credentials.rows[0].nonce})
    }
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
    await client.query(`INSERT INTO pending_actions(id,"userId",action,input) VALUES($1,$2,'credential_operation',$3)`, [plan.actionId, caller.userId, JSON.stringify({ ...plan, digest: credentialPlanDigest(caller.userId, plan) })])
    if(operation==='login') await client.query("UPDATE pending_actions SET status='running' WHERE id=$1",[plan.actionId])
    const needs = JSON.stringify({ kind: 'approval', actionId: plan.actionId, summary: plan.summary })
    await client.query(`WITH changed AS (UPDATE bot_subagents SET status=$6,step=$7,needs=$5,"activeActionId"=$8 WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 RETURNING *) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event) SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`, [plan.subagentId, caller.userId, plan.workspaceId, plan.botId, operation==='login'?null:needs,operation==='login'?'running':'needs_you',operation==='login'?'Signing in':'Credential approval',operation==='login'?plan.actionId:null])
    if(operation==='login') await client.query(`UPDATE bot_subagents SET status='running',step='Signing in',needs=NULL,"activeActionId"=$2 WHERE id=$1`,[plan.subagentId,plan.actionId])
    await client.query('COMMIT')
    if(operation!=='login') return { status: 'needs_approval' as const, origin: target.origin }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const raw={...plan,digest:credentialPlanDigest(caller.userId,plan)}
  const outcome=await executeCredentialOperation(pool,caller.userId,raw,true)
  if('error' in outcome) throw new Error(outcome.error)
  return {status:String(outcome.data.status ?? 'guarded'),origin:target.origin}
}

export async function executeCredentialOperation(pool: Pool, userId: string, raw: unknown, approved: boolean): Promise<{ data: Record<string, unknown> } | { error: string }> {
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
    const ledger = await pool.query(`SELECT 1 FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action='credential_operation' AND status=$3 AND input=$4::jsonb AND "createdAt">now()-interval '5 minutes'`, [plan.actionId, userId, approved ? 'running' : 'declined', JSON.stringify(raw)])
    if (!ledger.rowCount) return { error: 'browserActionExpired' }
    bound=true
    if(plan.operation==='login' && (!plan.credentialId || !plan.credentialRevision)) return {error:'credentialGrantRevoked'}
    const actor = { userId, workspaceId: plan.workspaceId }, store = new SubagentStore(pool)
    const row = await store.get(actor, plan.botId, plan.subagentId)
    if ((plan.operation==='login' ? row.status!=='running' || row.activeActionId!==plan.actionId : row.status!=='needs_you' || row.needs?.kind!=='approval' || row.needs.actionId!==plan.actionId) || Number(row.epoch) !== plan.epoch || row.targetId !== plan.targetId) return { error: 'browserActionExpired' }
    const caller = { ...actor, botId: plan.botId, subagentId: plan.subagentId }
    if (!approved && plan.operation !== 'submit') { await store.stop(actor, plan.botId, plan.subagentId); return { data: {} } }
    const { credentialStore, executeCredentialLease } = await import('@/lib/credentials/runtime')
    await credentialStore.authorize(caller)
    const target: BrowserTarget = { targetId: plan.targetId, origin: plan.origin, endpoint: '', expiresAt: plan.expiresAt, observedInputs: plan.inputs.map(input => ({ ...input, loaderId: plan!.loaderId, epoch: plan!.epoch, permissionVersion: plan!.permissionVersion })) }
    if (plan.operation === 'fill' || plan.operation === 'login') {
      if(plan.operation==='login') {
        const consent=await pool.query(`SELECT 1 FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND c.unattended_allowed=true AND s.nonce=$4`,[plan.credentialId,userId,plan.origin,plan.credentialRevision])
        if(!consent.rowCount) return {error:'credentialGrantRevoked'}
        const claimed=await pool.query(`UPDATE pending_actions SET result=$2 WHERE id=$1 AND status='running' AND result IS NULL RETURNING id`,[plan.actionId,{invocationStarted:true}])
        if(!claimed.rowCount) return {error:'browserActionOutcomeUnknown'}
      }
      const { resolveSubagentBrowserTarget } = await import('./subagent-browser')
      const fresh = await resolveSubagentBrowserTarget(caller)
      if (fresh.targetId !== plan.targetId || fresh.origin !== plan.origin || JSON.stringify(fresh.observedInputs) !== JSON.stringify(target.observedInputs)) return { error: 'browserActionExpired' }
      const lease = await credentialStore.lease(caller, plan.origin, fresh, plan.submittedUsername, plan.forcePassword, plan.operation==='login' ? {credentialId:plan.credentialId!,revision:plan.credentialRevision!} : undefined)
      if (lease.status === 'needs_login') {
        if(plan.operation==='login') {
          await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1 AND "userId"=$3`,[plan.actionId,{status:'needs_login'},userId])
          await pool.query('UPDATE bot_subagents SET "activeActionId"=NULL WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3',[plan.subagentId,userId,plan.actionId])
        }
        await store.update(actor, plan.botId, plan.subagentId, 'needs_you', 'login unavailable', { kind: 'login', site: plan.origin })
        return { data: { status: 'needs_login' } }
      }
      // Broker itself holds policy+credential locks and rechecks exact version.
      const result = await executeCredentialLease(lease.lease, plan.origin)
      if (result.status !== 'guarded') {
        await store.update(actor,plan.botId,plan.subagentId,'running','Observe login outcome')
        if(plan.operation==='login') await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1`,[plan.actionId,{status:result.status}])
        return {data:{status:result.status}}
      }
      if(plan.operation==='fill') {
        await proposeCredentialOperation(pool,caller,target,'submit')
        return {data:{status:result.status}}
      }
      // The saved-login grant covers one sign-in, not just a fill. Continue to
      // same-document submission without requesting the same consent twice.
    }
    const client = await pool.connect()
    let resumed = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${plan.workspaceId}`])
      const current = (await client.query(`SELECT s.*,m."sandboxId",COALESCE(p.version,0) AS "permissionVersion",p.permission FROM bot_subagents s JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId" AND m.state='running' LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId" WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4 FOR UPDATE OF s`, [plan.subagentId, userId, plan.workspaceId, plan.botId])).rows[0]
      if (!current || (plan.operation==='login' ? !['running','needs_you'].includes(current.status) || current.activeActionId!==plan.actionId : current.status !== 'needs_you' || current.needs?.actionId !== plan.actionId) || Number(current.epoch) !== plan.epoch || current.targetId !== plan.targetId || current.permission === 'deny' || Number(current.permissionVersion) !== plan.permissionVersion) throw new Error('Credential action expired')
      if(plan.operation==='login') {
        const consent=await client.query(`SELECT 1 FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND c.unattended_allowed=true AND s.nonce=$4 FOR SHARE OF c,s`,[plan.credentialId,userId,plan.origin,plan.credentialRevision])
        if(!consent.rowCount) throw new Error('Credential grant revoked')
      }
      const { connectComputer } = await import('@/lib/computer/e2b-provider')
      const { grant, endpointPath } = await import('./runtime')
      // Declining Submit is explicitly labelled Clear instead in the owner UI.
      const operation = approved ? (plan.operation==='login'?'submit':plan.operation) : 'clear'
      const capability = await grant(await connectComputer(plan.workspaceId, current.sandboxId), current, 'credential-continuation', { actionId: plan.actionId, operation, targetId: plan.targetId, origin: plan.origin, loaderId: plan.loaderId, inputs: plan.inputs })
      const response = await fetch(endpointPath(capability.endpoint, '/credentials/continue'), { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000) })
      if (!response.ok) throw new Error('Credential action outcome unknown')
      const result = z.object({ resumed: z.boolean(), operation: z.enum(['submit','clear']) }).strict().parse(await response.json())
      if (result.operation !== operation) throw new Error('Credential action outcome unknown')
      resumed = result.resumed
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    if (resumed) await store.update(actor, plan.botId, plan.subagentId, 'running', 'Observe login outcome')
    else if (approved && plan.operation === 'submit') await proposeCredentialOperation(pool, caller, target, 'clear')
    // A clear that cannot prove safety remains needs_you; never retry implicitly.
    else await store.update(actor, plan.botId, plan.subagentId, 'needs_you', 'Credential page remains hidden', { kind: 'login', site: plan.origin })
    if(plan.operation==='login') {
      await pool.query(`UPDATE pending_actions SET status='done',result=$2 WHERE id=$1`,[plan.actionId,{status:resumed?'resumed':'guarded'}])
      if(!resumed) {
        await pool.query('UPDATE bot_subagents SET "activeActionId"=NULL WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3',[plan.subagentId,userId,plan.actionId])
        await store.update(actor,plan.botId,plan.subagentId,'needs_you','Login needs additional input',{kind:'login',site:plan.origin})
      }
    }
    return { data: { status: resumed ? 'resumed' : 'guarded' } }
  } catch {
    // Never release the gateway guard on an unknown result or manufacture an
    // authentication result. The consumed ledger prevents an automatic retry.
    if (plan && bound) await new SubagentStore(pool).update({ userId, workspaceId: plan.workspaceId }, plan.botId, plan.subagentId, 'needs_you', 'Credential action outcome unknown', { kind: 'login', site: plan.origin }).catch(() => undefined)
    return { error: 'browserActionOutcomeUnknown' }
  }
}
