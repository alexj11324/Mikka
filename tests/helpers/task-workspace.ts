import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** The calling suite owns and guards its disposable database. */
export async function seedFixtureWorkspace(pool: Pick<Pool, 'query'>, ownerId: string, kind: 'personal' | 'team' = 'personal', id: string = randomUUID()) {
  if (kind === 'personal') {
    const existing = (await pool.query<{ id: string }>(
      `SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind='personal'`, [ownerId],
    )).rows[0]
    if (existing) return existing.id
  }
  await pool.query(
    `INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,'Task fixture',$3,$4)`,
    [id, ownerId, `fixture-${id}`, kind],
  )
  await pool.query(
    `INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'admin','active')`,
    [id, ownerId, `${ownerId}@example.invalid`],
  )
  return id
}
