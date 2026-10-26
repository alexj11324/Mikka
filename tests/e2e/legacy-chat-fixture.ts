import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect } from './fixtures'

export async function seedLegacyHistory(email: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Historical fixtures require E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Only the disposable E2E database is allowed')
  const pool = new Pool({ connectionString, max: 1 })
  const id = randomUUID()
  const title = `saved-${id.slice(0, 8)}`
  const completion = 'root = Stack([TextContent("已保存的公开测试历史正文"), BeButton("旧消息动作", "不得执行历史动作", "outline")])'
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    expect(user).toBeTruthy()
    await pool.query('INSERT INTO agent_sessions (id, "userId", title) VALUES ($1, $2, $3)', [id, user.id, title])
    await pool.query('INSERT INTO agent_turns (id, "sessionId", "userId", prompt, completion, status, "attemptId") VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), id, user.id, '公开测试历史问题', completion, 'complete', randomUUID()])
    return { id, title, completion }
  } finally { await pool.end() }
}
