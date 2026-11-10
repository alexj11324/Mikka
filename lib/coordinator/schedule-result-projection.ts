import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { scheduleChatMessage } from '@/lib/schedules/chat-result'

type MessageRow = { id?: string; message: Record<string, unknown> }
type Receipt = { operationId: string; title: string; status: string; result: unknown }

/**
 * Historical scheduler receipts had no host marker. Recognize them by their
 * persisted operation-to-message identity and original owner/chat, never by
 * their words alone. This is a read projection; the stored evidence is retained.
 */
export async function projectScheduleResults<T extends MessageRow>(executor: Pick<typeof db, 'execute'>, ownerId: string, rows: readonly T[]): Promise<T[]> {
  const ids = rows.flatMap(row => row.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) && row.message.role === 'assistant'
    && !row.message.mikkaScheduleResult && typeof row.message.content === 'string' && row.message.content.startsWith('[Schedule ') ? [row.id] : [])
  if (!ids.length) return [...rows]
  const result = await executor.execute<Receipt>(sql`select o.operation_id as "operationId",o.definition->>'title' as title,o.status,o.result
    from schedule_occurrences o join user_schedules s on s.id=o.schedule_id
    join coordinator_messages m on m.id=o.operation_id and m."userId"=s.owner_id and m."botId" is not distinct from s.bot_id
    where s.owner_id=${ownerId} and o.operation_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})`)
  const receipts = new Map(result.rows.map(row => [row.operationId, row]))
  return rows.map(row => {
    const receipt = row.id ? receipts.get(row.id) : undefined
    return receipt ? { ...row, message: { ...row.message, ...scheduleChatMessage(receipt.title, receipt.status, receipt.result) } } : row
  })
}
