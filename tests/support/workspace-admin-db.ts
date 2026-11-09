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

export async function seedRun(pool: Pool, input: { userId: string; agentId: string; workspaceId?: string; botId?: string | null; issueId?: string | null; status?: string; startedAt?: Date | null; finishedAt?: Date | null }) {
  const id = randomUUID()
  const workspaceId = input.workspaceId ?? (!input.botId && !input.issueId ? await seedPersonalWorkspace(pool, input.userId) : null)
  await pool.query('insert into agent_runs (id,"userId","agentId","workspaceId","botId","issueId",status,"startedAt","finishedAt") values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, input.userId, input.agentId, workspaceId, input.botId ?? null, input.issueId ?? null, input.status ?? 'succeeded', input.startedAt ?? null, input.finishedAt ?? null])
  return id
}

/** Fixtures explicitly default to a personal tenant; production never backfills by creator. */
export async function seedPersonalWorkspace(pool: Pool, userId: string) {
  const existing = (await pool.query<{ id: string }>('select id from mikka_workspaces where "userId"=$1 and kind=\'personal\'', [userId])).rows[0]
  if (existing) return existing.id
  const id = randomUUID()
  await pool.query('insert into mikka_workspaces (id,"userId",name,slug,kind) values ($1,$2,\'Personal\',$3,\'personal\')', [id, userId, `personal-${id}`])
  await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'admin\',\'active\')', [id, userId, `${userId}@example.invalid`])
  return id
}

export async function seedIssue(pool: Pool, userId: string, workspaceId?: string) {
  const id = randomUUID()
  const tenant = workspaceId ?? await seedPersonalWorkspace(pool, userId)
  await pool.query(`insert into issues (id,"userId","workspaceId","ownershipState",scope,"linearSyncPolicy","linearSyncBlocked",title,content,status,priority)
    select $1,$2,w.id,'bound',case when w.kind='personal' then 'personal' else 'workspace' end,'disabled',true,'Task','{"type":"doc"}','todo','normal' from mikka_workspaces w where w.id=$3`, [id, userId, tenant])
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
  const issueId = await seedIssue(pool, userId, workspaceId)
  await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [issueId, teamId, workspaceId, userId])
  return issueId
}

export async function seedProject(pool: Pool, userId: string, links: Array<{ teamId: string; workspaceId: string }>) {
  const id = randomUUID()
  const workspaceId = links[0]?.workspaceId ?? await seedPersonalWorkspace(pool, userId)
  if (links.some(link => link.workspaceId !== workspaceId)) throw new Error('Project fixture cannot cross workspaces')
  await pool.query(`insert into workspace_projects (id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) values ($1,$2,$3,'P','','','planned','none','','','','','[]',1)`, [id, userId, workspaceId])
  for (const link of links) await pool.query('insert into mikka_team_projects ("projectId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, link.teamId, link.workspaceId, userId])
  return id
}


/** Canonical relation fixtures; no production write to the retired JSON cache. */
export async function seedProjectTasks(pool: Pool, projectId: string, issueIds: string[]) {
  await pool.query('delete from workspace_project_tasks where "projectId"=$1', [projectId])
  for (const issueId of issueIds) await pool.query(`insert into workspace_project_tasks("projectId","issueId","workspaceId")
    select p.id,i.id,p."workspaceId" from workspace_projects p join issues i on i.id=$2 and i."workspaceId"=p."workspaceId" and i."ownershipState"='bound' where p.id=$1`, [projectId, issueId])
}

export const count = async (pool: Pool, text: string, params: unknown[]) => Number((await pool.query<{ n: string }>(`select count(*)::text as n from ${text}`, params)).rows[0].n)

/**
 * The workspace's free messages (TRIAL_MESSAGES, no card yet) are used up: one
 * more message than the trial sent in a chat there, so Mikka 默认 asks for a card.
 */
export async function useUpFreeMessages(pool: Pool, workspaceId: string, ownerId: string) {
  const { TRIAL_MESSAGES } = await import('../../lib/abuse/policy')
  const bot = await seedBot(pool, workspaceId, ownerId)
  for (let i = 0; i <= TRIAL_MESSAGES; i++)
    await pool.query(`insert into coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) values ($1,$2,$3,'user_message',$4,$5)`, [randomUUID(), ownerId, bot, `user_message:${randomUUID()}`, JSON.stringify({ text: `message ${i}` })])
}
