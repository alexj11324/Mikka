import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { sourcedEventMessage } from './message-safety'
import { projectScheduleResults } from './schedule-result-projection'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'

type MessageRow = { id?: string; message: Record<string, unknown> }
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const UUID_PATTERN = new RegExp(UUID,'i')

/** One read-time audience boundary for full/history/delta and bot previews.
 * Legacy human input is recovered only from an actual owner/chat-bound receipt.
 * Old welcome/user rows without a distinguishing receipt are not guessed at.
 */
export async function projectMessageDisplays<T extends MessageRow>(executor: Pick<typeof db, 'execute'>, ownerId: string, rows: readonly T[]): Promise<T[]> {
  const projected = await projectScheduleResults(executor, ownerId, rows)
  const ids = projected.flatMap(row => row.id && UUID_PATTERN.test(row.id) && row.message.role === 'user'
    && !row.message.mikkaDisplay && row.message.mikkaUserEvent && typeof row.message.mikkaUserEvent === 'object'
    && typeof (row.message.mikkaUserEvent as {id?:unknown}).id === 'string' ? [row.id] : [])
  if (!ids.length) return projected
  const result = await executor.execute<{messageId:string;payload:Record<string,unknown>}>(sql`
    select m.id as "messageId",jsonb_build_object('text',e.payload->'text','source',e.payload->'source') as payload from coordinator_messages m join coordinator_events e
      on e.id=(case when m.message#>>'{mikkaUserEvent,id}' ~* ${UUID} then m.message#>>'{mikkaUserEvent,id}' end)::uuid
        and e."userId"=m."userId" and e."botId" is not distinct from m."botId" and e.kind='user_message'
    where m."userId"=${ownerId} and m.id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})
      and (e.payload->>'source' in ('person','coordinator_welcome') or e.payload ? 'humanSessionId'
        or e.payload ? 'telegram' or e."dedupeKey" like 'personal_submission:v1:%')`)
  const receipts=new Map(result.rows.map(row=>[row.messageId,row.payload]))
  return projected.map(row=>{
    const payload=row.id?receipts.get(row.id):undefined
    if (!payload || typeof payload.text!=='string') return row
    const message=maskDeep(sourcedEventMessage({kind:'user_message',issueId:null,runId:null,payload},payload.text),credentialMasker)
    return {...row,message:{...row.message,mikkaDisplay:message.mikkaDisplay}}
  })
}
