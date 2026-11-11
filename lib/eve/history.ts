import type { SessionHistoryMessage } from 'eve/channels'
import type { EveScope } from './scope'

/** Only old text is imported. Historic rich rows remain immutable in Mikka. */
export async function priorHistory(scope: EveScope): Promise<SessionHistoryMessage[]> {
  if (scope.surface !== 'web') return []
  const { pool } = await import('../db')
  const { rows } = await pool.query<{ id: string; message: { role: string; content: unknown } }>(
    'SELECT id,message FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position', [scope.ownerId, scope.botId])
  return rows.flatMap(row => {
    if (row.message.role !== 'user' && row.message.role !== 'assistant') return []
    const text = typeof row.message.content === 'string' ? row.message.content : Array.isArray(row.message.content)
      ? row.message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : ''
    return text.trim() ? [{ id: row.id, role: row.message.role, text }] : []
  })
}
