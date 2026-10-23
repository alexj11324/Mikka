// Ownership and built-in guards of the agent actions, against a real database.
// Needs the isolated E2E database (E2E_DATABASE_URL, same as `pnpm test:e2e:setup`);
// skipped without it. The session is stubbed so each call acts as a chosen user.
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.E2E_DATABASE_URL
const skip = !url && 'E2E_DATABASE_URL is not set'
if (url) {
  const target = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Agent action tests only run against the local *_e2e database.')
  process.env.DATABASE_URL = url
  process.env.MIKKA_DATABASE_URL = url
}

let actingUser = ''
mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } })
mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => (actingUser ? { user: { id: actingUser } } : null) } } } })

const owner = `agent-test-owner-${randomUUID()}`
const other = `agent-test-other-${randomUUID()}`
const customId = randomUUID()
const builtInId = randomUUID()
const deviceId = randomUUID()
const repoId = randomUUID()
const issueId = randomUUID()
let actions: typeof import('@/app/actions/agents')
let pool: typeof import('@/lib/db').pool

before(async () => {
  if (skip) return
  // Issue access (workspaces, teams) is covered elsewhere; here the owner simply has this issue.
  const issueAccess = await import('@/lib/issue-access')
  mock.module('@/lib/issue-access', { namedExports: { ...issueAccess, issueForUser: async (userId: string, id: string) => (userId === owner && id === issueId ? { id, title: 'Fix it', content: { type: 'doc', content: [] } } : null) } })
  actions = await import('@/app/actions/agents')
  ;({ pool } = await import('@/lib/db'))
  await pool.query(`insert into agents (id, "userId", role, name, description, instructions) values ($1, $3, 'custom', 'Mine', 'mine', 'mine'), ($2, $3, 'worker', 'Worker', 'edited', 'edited')`, [customId, builtInId, owner])
  const harnesses = [{ harness: 'claude_code', installed: true, models: [{ value: 'opus', displayName: 'Opus', efforts: ['low', 'high'] }], permissionModes: ['plan'] }]
  await pool.query(`insert into devices (id, "ownerId", name, harnesses, "lastSeenAt") values ($1, $2, 'Test Mac', $3, now())`, [deviceId, owner, JSON.stringify(harnesses)])
  await pool.query(`insert into device_repos (id, "deviceId", "userId", "repoPath") values ($1, $2, $3, '/tmp/repo')`, [repoId, deviceId, owner])
})

after(async () => {
  if (skip || !pool) return
  await pool.query('delete from agent_runs where "userId" = any($1)', [[owner, other]])
  await pool.query('delete from agents where "userId" = any($1)', [[owner, other]])
  await pool.query('delete from device_repos where "userId" = any($1)', [[owner, other]])
  await pool.query('delete from devices where "ownerId" = any($1)', [[owner, other]])
  await pool.end()
})

const draft = { name: 'Taken over', description: '', instructions: '', deviceId: null, harness: null, model: null, effort: null, permissionMode: null, icon: null, color: null }
const row = async (id: string) => (await pool.query('select "userId", name, description, instructions from agents where id = $1', [id])).rows[0]

test('another user cannot update, delete or reset an agent: agentNotFound, row unchanged', { skip }, async () => {
  actingUser = other
  assert.equal((await actions.updateAgent({ id: customId, ...draft }) as { error?: string }).error, 'agentNotFound')
  assert.equal((await actions.deleteAgent(customId) as { error?: string }).error, 'agentNotFound')
  assert.equal((await actions.resetAgentInstructions(builtInId) as { error?: string }).error, 'agentNotFound')
  assert.deepEqual(await row(customId), { userId: owner, name: 'Mine', description: 'mine', instructions: 'mine' })
  assert.deepEqual(await row(builtInId), { userId: owner, name: 'Worker', description: 'edited', instructions: 'edited' })
})

test('the owner cannot delete a built-in agent: agentBuiltInDelete, row kept', { skip }, async () => {
  actingUser = owner
  assert.equal((await actions.deleteAgent(builtInId) as { error?: string }).error, 'agentBuiltInDelete')
  assert.equal((await row(builtInId))?.userId, owner)
})

const runtimeRow = async (id: string) => (await pool.query('select "deviceId", harness, model, effort, "permissionMode" from agents where id = $1', [id])).rows[0]

test('update reports an option the device did not list, and saves nothing', { skip }, async () => {
  actingUser = owner
  const pinned = { ...draft, name: 'Mine', deviceId, harness: 'claude_code' as const, model: 'opus' }
  assert.equal((await actions.updateAgent({ id: customId, ...pinned, permissionMode: 'bypassPermissions' }) as { error?: string }).error, 'agentPermissionModeInvalid')
  assert.equal((await actions.updateAgent({ id: customId, ...pinned, effort: 'max' }) as { error?: string }).error, 'agentEffortInvalid')
  assert.deepEqual(await runtimeRow(customId), { deviceId: null, harness: null, model: null, effort: null, permissionMode: null })
  // The same agent with listed options saves, so the errors above come from the option check.
  assert.deepEqual(await actions.updateAgent({ id: customId, ...pinned, effort: 'high', permissionMode: 'plan' }), { success: true })
  assert.deepEqual(await runtimeRow(customId), { deviceId, harness: 'claude_code', model: 'opus', effort: 'high', permissionMode: 'plan' })
})

test('a queued run keeps effort and mode on the pinned harness, and clears both when another harness runs it', { skip }, async () => {
  actingUser = owner
  const run = async (agentId: string) => {
    const { runId } = await actions.startRun({ issueId, agentId, deviceRepoId: repoId })
    return (await pool.query('select harness, effort, "permissionMode" from agent_runs where id = $1', [runId])).rows[0]
  }
  await pool.query(`update agents set "deviceId" = null, harness = 'claude_code', model = null, effort = 'high', "permissionMode" = 'plan' where id = $1`, [customId])
  assert.deepEqual(await run(customId), { harness: 'claude_code', effort: 'high', permissionMode: 'plan' })
  // Auto harness: the run lands on claude_code, which is not the agent's own pinned harness, so its values do not carry over.
  await pool.query(`update agents set harness = null where id = $1`, [customId])
  assert.deepEqual(await run(customId), { harness: 'claude_code', effort: null, permissionMode: null })
})
