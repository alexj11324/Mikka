// Shared fixture for the workspace settings DB suites: a throwaway local
// Postgres (both database targets on one URL) and seed helpers.
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export const dbUrl = process.env.E2E_DATABASE_URL
if (dbUrl) {
  const target = new URL(dbUrl)
  if (target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e') || process.env.MIKKA_DATABASE_URL !== dbUrl || process.env.DATABASE_URL !== dbUrl) {
    throw new Error('Workspace settings DB tests require an isolated local *_e2e database for every target')
  }
}
if (!dbUrl && process.env.REQUIRE_DB === '1') throw new Error('Workspace settings DB tests cannot skip in required CI')

export async function seedUser(pool: Pool, label: string) {
  const id = `${label}-${randomUUID()}`
  await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [id, label, `${id}@example.invalid`])
  return id
}

export async function seedWorkspace(pool: Pool, ownerId: string, members: Array<{ userId: string; role: 'admin' | 'member'; status?: 'active' | 'suspended' }>, name = `WS ${randomUUID().slice(0, 6)}`) {
  const id = randomUUID()
  const slug = `ws-${id.slice(0, 8)}`
  await pool.query('insert into mikka_workspaces (id,"userId",name,slug) values ($1,$2,$3,$4)', [id, ownerId, name, slug])
  for (const member of members) {
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$3,$4,$5,$6)', [id, member.userId, member.userId, `${member.userId}@example.invalid`, member.role, member.status ?? 'active'])
  }
  return { id, name, slug }
}

export async function seedBot(pool: Pool, workspaceId: string, ownerId: string, name = `Bot ${randomUUID().slice(0, 6)}`) {
  const id = randomUUID()
  await pool.query('insert into bots (id,"ownerId","workspaceId",name) values ($1,$2,$3,$4)', [id, ownerId, workspaceId, name])
  return id
}

export async function seedAgent(pool: Pool, userId: string, harness = 'codex') {
  const id = randomUUID()
  await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,$3,$4)', [id, userId, harness, `agent-${id.slice(0, 8)}`])
  return id
}

export async function seedRun(pool: Pool, input: { userId: string; agentId: string; botId?: string | null; issueId?: string | null; status?: string; startedAt?: Date | null; finishedAt?: Date | null }) {
  const id = randomUUID()
  await pool.query('insert into agent_runs (id,"userId","agentId","botId","issueId",status,"startedAt","finishedAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, input.userId, input.agentId, input.botId ?? null, input.issueId ?? null, input.status ?? 'succeeded', input.startedAt ?? null, input.finishedAt ?? null])
  return id
}

export async function seedIssue(pool: Pool, userId: string) {
  const id = randomUUID()
  await pool.query(`insert into issues (id,"userId",title,content,status,priority) values ($1,$2,'Task','{"type":"doc"}','todo','normal')`, [id, userId])
  return id
}

export async function seedTeam(pool: Pool, workspaceId: string, ownerId: string, name = `Team ${randomUUID().slice(0, 6)}`) {
  const id = randomUUID()
  const identifier = `T${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'A')}`
  await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,$4,$5)', [id, workspaceId, ownerId, name, identifier])
  await pool.query('insert into mikka_team_members ("teamId","userId",role) values ($1,$2,\'owner\')', [id, ownerId])
  return { id, name }
}

export async function seedTeamIssue(pool: Pool, workspaceId: string, teamId: string, userId: string) {
  const issueId = await seedIssue(pool, userId)
  await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [issueId, teamId, workspaceId, userId])
  return issueId
}

export async function seedProject(pool: Pool, userId: string, links: Array<{ teamId: string; workspaceId: string }>) {
  const id = randomUUID()
  await pool.query(`insert into workspace_projects (id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) values ($1,$2,'P','','','planned','none','','','','','[]',1)`, [id, userId])
  for (const link of links) await pool.query('insert into mikka_team_projects ("projectId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, link.teamId, link.workspaceId, userId])
  return id
}

export const count = async (pool: Pool, text: string, params: unknown[]) => Number((await pool.query<{ n: string }>(`select count(*)::text as n from ${text}`, params)).rows[0].n)
