import type { SessionHistoryMessage } from 'eve/channels'
import type { EveScope } from './scope'

/** Only old text is imported. Historic rich rows remain immutable in Mikka. */
export async function priorHistory(scope: EveScope): Promise<SessionHistoryMessage[]> {
  if (scope.surface !== 'web') return []
  const { pool } = await import('../db')
  const { rows } = await pool.query<SessionHistoryMessage>(`
    SELECT id, message->>'role' AS role,
      coalesce(CASE jsonb_typeof(message->'content')
        WHEN 'string' THEN message->>'content'
        WHEN 'array' THEN (
          SELECT string_agg(part->>'text', E'\\n' ORDER BY ordinality)
          FROM jsonb_array_elements(message->'content') WITH ORDINALITY AS parts(part, ordinality)
          WHERE part->>'type' = 'text' AND jsonb_typeof(part->'text') = 'string'
        )
      END, '') AS text
    FROM coordinator_messages
    WHERE "userId"=$1 AND "botId"=$2 AND message->>'role' IN ('user','assistant')
    ORDER BY position`, [scope.ownerId, scope.botId])
  return rows.filter(row => row.text.trim())
}
