import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ActionFailureError } from './action-error'
import { readRunChain } from './run-chain'
import { factoryEventId } from './factory/event-id'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import { withFactoryBackgroundWorkspace } from './factory/background-workspace'

export const versionInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('edit'), anchorRunId: z.uuid(), anchorKey: z.uuid(), requestId: z.uuid(), text: z.string().trim().min(1).max(10_000) }).strict(),
  z.object({ operation: z.literal('rerun'), anchorRunId: z.uuid(), anchorKey: z.string().min(1).max(320), requestId: z.uuid() }).strict(),
])
export type ReplyVersionInput = z.infer<typeof versionInput>

type Anchor = { originalText: string; ownerInput: string; time: Date }
type Receipt = { id: string; userId: string; workspaceId: string; rootRunId: string; anchorRunId: string; anchorKey: string;
  operation: 'edit' | 'rerun'; originalText: string; admissionRunId: string; text: string; executionNote: string; resultRunId: string | null }

async function versionAnchor(pool: Pool, userId: string, input: ReplyVersionInput): Promise<Anchor> {
  if (input.operation === 'edit') {
    const { rows: [row] } = await pool.query<Anchor>(`SELECT text AS "originalText",text AS "ownerInput","createdAt" AS time FROM run_messages
      WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND origin='owner' AND "deliveredAt" IS NOT NULL AND failure IS NULL`,
    [input.anchorKey, input.anchorRunId, userId])
    if (!row) throw new ActionFailureError('runNotFound')
    return row
  }
  const { rows: [row] } = await pool.query<Anchor>(`WITH answer AS (
      SELECT min(c."createdAt") AS time,string_agg(c.chunk->>'delta','' ORDER BY c.seq) AS text
      FROM run_chunks c WHERE c."runId"=$1 AND c.chunk->>'type'='text-delta' AND c.chunk->>'id'=$2
      HAVING count(*)>0)
    SELECT answer.text AS "originalText", coalesce(m.text,CASE WHEN r."promptTaskLength">0 THEN substring(r.prompt FROM coalesce(r."promptTaskStart",0)+1 FOR r."promptTaskLength") END) AS "ownerInput",answer.time
    FROM answer JOIN agent_runs r ON r.id=$1 AND r."userId"=$3
    LEFT JOIN LATERAL (SELECT text FROM run_messages WHERE "runId"=r.id AND "userId"=$3 AND origin='owner' AND "deliveredAt" IS NOT NULL AND failure IS NULL AND "createdAt"<=answer.time ORDER BY "createdAt" DESC,id DESC LIMIT 1) m ON true`,
  [input.anchorRunId, input.anchorKey, userId])
  if (!row?.ownerInput || !row.originalText) throw new ActionFailureError('threadCannotContinue')
  return row
}

export async function createReplyVersion(pool: Pool, userId: string, runId: string, raw: ReplyVersionInput) {
  const input = versionInput.parse(raw)
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id: runId }, async () => {
    const chain = await readRunChain(pool, userId, runId)
    if (!chain?.attempts.some(attempt => attempt.runId === input.anchorRunId)) throw new ActionFailureError('runNotFound')
    const { rows: [scope] } = await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2',[runId,userId])
    if (!scope) throw new ActionFailureError('runNotFound')
    const id = factoryEventId('thread-version', JSON.stringify([userId,input.requestId.toLowerCase()]))
    const read = async () => (await pool.query<Receipt>('SELECT * FROM thread_reply_versions WHERE id=$1 AND "userId"=$2', [id,userId])).rows[0]
    let receipt = await read()
    if (!receipt) {
      if (!chain.attempts.at(-1) || UNFINISHED_RUN_STATUSES.some(status => status === chain.attempts.at(-1)?.status)) throw new ActionFailureError('threadStopping')
      const anchor = await versionAnchor(pool, userId, input)
      const text = input.operation === 'edit' ? input.text : anchor.ownerInput.trim()
      const precedingRuns = chain.attempts.slice(0,chain.attempts.findIndex(attempt => attempt.runId === input.anchorRunId)+1).map(attempt => attempt.runId)
      // Take the transcript prefix from the host, excluding the original input/reply
      // and every later turn. Tool output cannot supply new owner authority.
      const { rows: history } = await pool.query<{ role: string; text: string }>(`SELECT role,text FROM (
        SELECT 'owner' AS role,m.text,m."createdAt" AS at,m.id::text AS tie FROM run_messages m WHERE m."userId"=$1 AND m."runId"=ANY($2::uuid[])
          AND m.origin='owner' AND m."deliveredAt" IS NOT NULL AND m.failure IS NULL AND m."createdAt"<$3
        UNION ALL SELECT 'assistant',string_agg(c.chunk->>'delta','' ORDER BY c.seq),min(c."createdAt"),c."runId"::text||':'||coalesce(c.chunk->>'id','')
          FROM run_chunks c WHERE c."runId"=ANY($2::uuid[]) AND c.chunk->>'type'='text-delta' AND c."createdAt"<$3 GROUP BY c."runId",c.chunk->>'id'
        ) prefix ORDER BY at DESC,tie DESC LIMIT 24`, [userId,precedingRuns,anchor.time])
      const context = history.reverse().map(row => ({ role:row.role, text:row.text })).filter(row => row.text)
      const note = ['Restart at the selected conversation message. Earlier conversation text is context. Existing commits, pull requests and messages are retained. Inspect existing work before an external action.',
        context.length ? JSON.stringify(context).slice(-3000) : '', text].filter(Boolean).join('\n\n')
      // The writer's 10k limit applies to owner text. Preserve all of it,
      // dropping historical context from the execution brief when necessary.
      const executionNote = Array.from(note).length <= 10_000 ? note : text
      const sourceId = factoryEventId('thread-submission',JSON.stringify([userId,id]))
      await pool.query(`INSERT INTO thread_reply_versions (id,"userId","workspaceId","rootRunId","anchorRunId","anchorKey","admissionRunId",operation,"originalText",text,"executionNote","sourceEventId")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [id,userId,scope.workspaceId,chain.rootRunId,input.anchorRunId,input.anchorKey,chain.latestRunId,input.operation,anchor.originalText,text,executionNote,sourceId])
      receipt = await read()
    }
    if (!receipt || receipt.rootRunId !== chain.rootRunId || receipt.workspaceId !== scope.workspaceId || receipt.operation !== input.operation ||
      receipt.anchorRunId !== input.anchorRunId || receipt.anchorKey !== input.anchorKey || (input.operation === 'edit' && receipt.text !== input.text)) throw new ActionFailureError('submissionConflict')
    if (receipt.resultRunId) return { runId:receipt.resultRunId, versionId:id }
    const { sendThreadMessage } = await import('./thread-continue')
    const sent = await sendThreadMessage(userId, receipt.admissionRunId, receipt.text, 'user', id, 'version')
    if (!sent.continued) throw new ActionFailureError('threadCannotContinue')
    return { runId:sent.runId, versionId:id }
  })
}

/** Lists immutable inputs and the exact corresponding output, never modifying
 * the active task, native session, publication or another reader's selection. */
export async function readReplyVersions(pool: Pool, userId: string, runId: string) {
  return withFactoryBackgroundWorkspace(pool,userId,{kind:'run',id:runId},async () => {
    const chain = await readRunChain(pool,userId,runId)
    if (!chain) throw new ActionFailureError('runNotFound')
    return (await pool.query<{ id:string; anchorRunId:string; anchorKey:string; originalText:string; text:string; resultRunId:string|null; output:string|null; pullRequest:string|null; originalOutput:string|null; originalPullRequest:string|null }>(`
      SELECT v.id,v."anchorRunId",v."anchorKey",v."originalText",v.text,r.id AS "resultRunId",r."lastReply" AS output,
        p."pullRequest"->>'url' AS "pullRequest", source."lastReply" AS "originalOutput",prior."pullRequest"->>'url' AS "originalPullRequest"
        FROM thread_reply_versions v JOIN agent_runs source ON source.id=v."anchorRunId" AND source."workspaceId"=v."workspaceId" AND source."userId"=v."userId"
      LEFT JOIN run_publications prior ON prior."runId"=source.id AND prior."userId"=v."userId"
      JOIN agent_runs root ON root.id=v."rootRunId" AND root."userId"=v."userId" AND root."workspaceId"=v."workspaceId"
      LEFT JOIN agent_runs r ON r.id=v."resultRunId" AND r."userId"=v."userId" AND r."workspaceId"=v."workspaceId"
      LEFT JOIN run_publications p ON p."runId"=r.id AND p."userId"=v."userId"
      WHERE v."rootRunId"=$1 AND v."userId"=$2 ORDER BY v."createdAt",v.id`,[chain.rootRunId,userId])).rows
  })
}
