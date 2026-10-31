import type { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { cliPolicyGuard, cliAgentPolicyGuard, cliPolicyLayerSchema, lockCliRunPolicy, lockCliAgentPolicy, realCliMembershipGuard, type CliMembershipGuard } from './policy-store'

/** Own CLI fields only; external-write/computer choices are never changed. */
export async function setCliPolicy(pool: Pick<Pool, 'connect'>, ownerId: string, runId: string, target: 'agent' | 'worker' | 'workspace' | 'team' | 'project', expectedRevision: string, input: unknown, membership: CliMembershipGuard = realCliMembershipGuard) {
  const policy = cliPolicyLayerSchema.parse(input)
  const guard = cliPolicyGuard(runId,ownerId,membership)
  return writeTransaction(pool, async tx => {
    // Tool liveness and approval decisions lock run -> policy. Take the run
    // first as well, so changing policy cannot hold its advisory lock while
    // waiting for a concurrent tool check's run lock.
    const { rows: [run] } = await tx.query<{ botId:string | null; agentId:string }>('SELECT "botId","agentId" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId,ownerId])
    if (!run) throw new Error('agentPolicyUnavailable')
    const current = await lockCliRunPolicy(tx,runId,ownerId)
    if (current.revision !== expectedRevision) throw new Error('agentPolicyChanged')
    if (target === 'agent') await tx.query('UPDATE agent_kit_heads SET cli_run_policy=$3 WHERE owner_id=$1 AND bot_key=$2', [ownerId,run.botId ?? 'coordinator',policy])
    else if (target === 'worker') await tx.query('UPDATE agents SET cli_run_policy=$3 WHERE id=$1 AND "userId"=$2', [run.agentId,ownerId,policy])
    else if (target === 'team' || target === 'project') {
      const scopeId = current.hierarchy?.[target === 'team' ? 'teamId' : 'projectId']
      if (!scopeId) throw new Error('agentPolicyUnavailable')
      await tx.query('UPDATE cli_scope_policies SET cli_run_policy=$3 WHERE kind=$1 AND scope_id=$2', [target,scopeId,policy])
    } else {
      if (!current.workspaceId) throw new Error('agentPolicyUnavailable')
      await tx.query('UPDATE workspace_computer_policies SET cli_run_policy=$2 WHERE "workspaceId"=$1', [current.workspaceId,policy])
    }
    const next = await lockCliRunPolicy(tx,runId,ownerId)
    if ((target === 'team' || target === 'project') && next.hierarchy) {
      const { recordAudit } = await import('@/lib/audit/record')
      await recordAudit(drizzle(tx),{ workspaceId: next.hierarchy.workspaceId,actor:{type:'user',id:ownerId,name:ownerId},action:'agent.policy_changed',
        target:{type:target,id:next.hierarchy[target === 'team' ? 'teamId' : 'projectId']!,label:target},metadata:{scope:target,revision:next.revision} })
    }
    return next
  }, { guard: async (tx,signal) => {
    const lease = await guard(tx,signal)
    try {
      if (target === 'workspace' || target === 'team' || target === 'project') {
        const current = await lockCliRunPolicy(tx,runId,ownerId)
        const workspaceId = target === 'workspace' ? current.workspaceId : current.hierarchy?.workspaceId
        if (!workspaceId || !lease.workspaceClient) throw new Error('agentPolicyUnavailable')
        const role = await lease.workspaceClient.query(`SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [workspaceId,ownerId])
        if (role.rows[0]?.role !== 'admin') throw new Error('agentPolicyUnavailable')
      }
      return lease
    } catch (error) { await lease.close(); throw error }
  } })
}

/** A person may configure a worker before its first run. */
export async function setCliAgentPolicy(pool: Pick<Pool, 'connect'>, ownerId: string, agentId: string, botId: string | null, target: 'agent' | 'worker' | 'workspace', expectedRevision: string, input: unknown, membership: CliMembershipGuard = realCliMembershipGuard) {
  const policy = cliPolicyLayerSchema.parse(input)
  const guard = cliAgentPolicyGuard(ownerId,agentId,botId,membership)
  return writeTransaction(pool, async tx => {
    const current = await lockCliAgentPolicy(tx,ownerId,agentId,botId)
    if (current.revision !== expectedRevision) throw new Error('agentPolicyChanged')
    if (target === 'agent') await tx.query('UPDATE agent_kit_heads SET cli_run_policy=$3 WHERE owner_id=$1 AND bot_key=$2', [ownerId,botId ?? 'coordinator',policy])
    else if (target === 'worker') await tx.query('UPDATE agents SET cli_run_policy=$3 WHERE id=$1 AND "userId"=$2', [agentId,ownerId,policy])
    else {
      if (!current.workspaceId) throw new Error('agentPolicyUnavailable')
      await tx.query('UPDATE workspace_computer_policies SET cli_run_policy=$2 WHERE "workspaceId"=$1', [current.workspaceId,policy])
    }
    return lockCliAgentPolicy(tx,ownerId,agentId,botId)
  }, { guard: async (tx,signal) => {
    const lease = await guard(tx,signal)
    try {
      if (target === 'workspace') {
        const current = await lockCliAgentPolicy(tx,ownerId,agentId,botId)
        if (!current.workspaceId || !lease.workspaceClient) throw new Error('agentPolicyUnavailable')
        const role = await lease.workspaceClient.query(`SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [current.workspaceId,ownerId])
        if (role.rows[0]?.role !== 'admin') throw new Error('agentPolicyUnavailable')
      }
      return lease
    } catch (error) { await lease.close(); throw error }
  } })
}
