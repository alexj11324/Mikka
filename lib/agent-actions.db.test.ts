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
let actions: typeof import('@/app/actions/agents')
let pool: typeof import('@/lib/db').pool

before(async () => {
  if (skip) return
  actions = await import('@/app/actions/agents')
  ;({ pool } = await import('@/lib/db'))
  await pool.query(`insert into agents (id, "userId", role, name, description, instructions) values ($1, $3, 'custom', 'Mine', 'mine', 'mine'), ($2, $3, 'worker', 'Worker', 'edited', 'edited')`, [customId, builtInId, owner])
})

after(async () => {
  if (skip || !pool) return
  await pool.query('delete from agents where "userId" = any($1)', [[owner, other]])
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
