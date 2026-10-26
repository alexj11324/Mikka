import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createParser } from '@openuidev/react-lang'
import { createAgentLibrary } from '../../lib/agent-ui-catalog'
import { expect } from './fixtures'

export async function seedLegacyHistory(email: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Historical fixtures require E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Only the disposable E2E database is allowed')
  const pool = new Pool({ connectionString, max: 1 })
  const id = randomUUID()
  const title = `saved-${id.slice(0, 8)}`
  const completion = 'root = Stack([TextContent("已保存的公开测试历史正文"), BeButton("继续细化", "不得执行历史动作", "outline")])'
  const library = createAgentLibrary()
  const parsed = createParser(library.toJSONSchema(), library.root).parse(completion)
  expect(parsed.meta.errors).toEqual([])
  expect(parsed.meta.unresolved).toEqual([])
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    expect(user).toBeTruthy()
    await pool.query('INSERT INTO agent_sessions (id, "userId", title) VALUES ($1, $2, $3)', [id, user.id, title])
    await pool.query('INSERT INTO agent_turns (id, "sessionId", "userId", prompt, completion, status, "attemptId") VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), id, user.id, '公开测试历史问题', completion, 'complete', randomUUID()])
    await pool.query('INSERT INTO agent_turns (id, "sessionId", "userId", prompt, completion, status, error, "attemptId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval \'1 second\')', [randomUUID(), id, user.id, '公开测试未完成问题', '', 'failed', '受控历史失败信息', randomUUID()])
    return { id, title, completion }
  } finally { await pool.end() }
}
