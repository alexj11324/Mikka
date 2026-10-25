import type { Pool } from 'pg'
import { z } from 'zod'
import type { Directory } from './group-conversations-store'
import { cancelWork, grantAgent, requireAgent, reject, requireGroup, transaction } from './group-review-access'

const commandSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('lead'),agentId:z.uuid().nullable()}).strict(),
  z.object({action:z.literal('reconcile'),workId:z.uuid(),decision:z.literal('abandon')}).strict(),
  z.object({ action: z.literal('grant'), agentId: z.uuid() }).strict(),
  z.object({ action: z.literal('revoke'), agentId: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel'), workId: z.uuid() }).strict(),
  z.object({ action: z.literal('work'), workId: z.uuid() }).strict(),
])
export async function groupReviewCommand(pool: Pool, directory: Directory, conversationId: string, userId: string, command: unknown) {
  const parsed = commandSchema.safeParse(command)
  if (!parsed.success || !z.uuid().safeParse(conversationId).success) return reject(422, 'invalid_input')
  const input = parsed.data
  return transaction(pool, async client => {
    const { group, member } = await requireGroup(client, directory, conversationId, userId)
    if(input.action==='lead'){
      if(member.role!=='owner')return reject(403,'forbidden')
      if(input.agentId)await requireAgent(client,directory,conversationId,group.workspaceId,input.agentId)
      await client.query('UPDATE conversations SET "leadAgentId"=$2 WHERE id=$1',[conversationId,input.agentId]);return{ok:true}
    }
    if (input.action === 'work' || input.action === 'cancel' || input.action==='reconcile') {
      const work = (await client.query('SELECT w.*,r.error AS "runtimeError" FROM conversation_work w LEFT JOIN agent_runs r ON r.id=w."runId" WHERE w.id=$1 AND w."conversationId"=$2', [input.workId, conversationId])).rows[0]
      if (!work) return reject(404, 'not_found')
      if(work.status==='dispatched' && work.runId){
        const run=(await client.query('SELECT status,"leaseExpiresAt" FROM agent_runs WHERE id=$1 FOR UPDATE',[work.runId])).rows[0]
        if(run?.status==='running' && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()<=Date.now()){
          const row=(await client.query('UPDATE conversation_work SET "uncertainAt"=coalesce("uncertainAt",now()) WHERE id=$1 RETURNING "uncertainAt"',[work.id])).rows[0]
          work.uncertainAt=row.uncertainAt
        }
      }

      if (input.action === 'work') return { work, executionState:work.status==='dispatched'&&work.uncertainAt?'uncertain':work.status }
      if(input.action==='reconcile'){
        if(work.requestedBy!==userId&&member.role!=='owner')return reject(403,'forbidden')
        if(!work.uncertainAt||work.status!=='dispatched')return reject(409,'reconciliation_not_required')
        await client.query(`INSERT INTO group_work_reconciliations("workId","userId",decision) VALUES($1,$2,'abandon') ON CONFLICT DO NOTHING`,[work.id,userId])
      }
      if (work.requestedBy !== userId && member.role !== 'owner') return reject(403, 'forbidden')
      await cancelWork(client, conversationId, { workId: work.id })
      return { ok: true }
    }
    if (input.action === 'grant') {
      // A human may explicitly share only their own Agent into this group.
      // This does not change the private Agent directory's ownership rule.
      if (!await directory(group.workspaceId, userId, [{ memberType: 'agent', memberId: input.agentId }], client)) return reject(404, 'not_found')
      await client.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'agent',$2,'member')
        ON CONFLICT ("conversationId","memberType","memberId") DO UPDATE SET "leftAt"=NULL,"joinedAt"=CASE WHEN conversation_members."leftAt" IS NULL THEN conversation_members."joinedAt" ELSE now() END`, [conversationId, input.agentId])
      await grantAgent(client, conversationId, input.agentId, userId)
      return { ok: true }
    }
    const grant = (await client.query('SELECT * FROM conversation_agent_grants WHERE "conversationId"=$1 AND "agentId"=$2 AND "revokedAt" IS NULL', [conversationId, input.agentId])).rows[0]
    if (!grant) return reject(404, 'not_found')
    if (grant.ownerId !== userId && member.role !== 'owner') return reject(403, 'forbidden')
    await client.query('UPDATE conversation_agent_grants SET "revokedAt"=now() WHERE id=$1', [grant.id])
    await cancelWork(client, conversationId, { agentId: input.agentId })
    return { ok: true }
  })
}
