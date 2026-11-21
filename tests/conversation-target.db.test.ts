import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createRequestScope, runRequestScope } from '../apps/api/src/context'
import { WORKSPACE_SELECTION_HEADER } from '../lib/workspace-selection'
import { desktopActionSchemas } from '../lib/desktop-rpc/schemas'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedAgent, seedUser, seedWorkspace } from './support/workspace-admin-db'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Conversation target tests require a disposable database')

test('authenticated header actions keep same-UUID chat and run distinct across owner and workspace boundaries', { skip: !enabled, timeout: 60_000 }, async t => {
  t.mock.module('@/lib/server-runtime/headers', { namedExports: await import('../lib/server-runtime/headers') })
  t.mock.module('@/lib/intl/i18n-server', { namedExports: await import('../lib/intl/i18n-server') })
  const calls: string[] = []
  t.mock.module('@/lib/default-model', { namedExports: { defaultModelAvailable: async () => true } })
  t.mock.module('@/lib/short-title-server', { namedExports: { generateShortTitle: async (_owner: string, content: { title: string }) => {
    calls.push(content.title)
    return content.title === 'Chat renamed' ? 'Chat generated' : 'Run generated'
  } } })
  const { auth } = await import('../lib/auth')
  const { renameConversation, regenerateConversationTitle, readConversationOrganization, setConversationOrganization } = await import('../app/actions/task-runs')
  const reader = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  const owner = await seedUser(reader, 'header-owner'), member = await seedUser(reader, 'header-member')
  const space = await seedWorkspace(reader, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const second = await seedWorkspace(reader, owner, [{ userId: owner, role: 'admin' }])
  const id = randomUUID(), agent = await seedAgent(reader, owner)
  t.after(async () => {
    await reader.query('DELETE FROM conversations WHERE id=$1', [id])
    await reader.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, member]])
    await reader.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[space.id, second.id]])
    await reader.end()
  })
  const context = await auth.$context
  const origin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
  async function login(user: string) {
    const password = randomUUID() + randomUUID()
    await context.internalAdapter.createAccount({ userId: user, accountId: user, providerId: 'credential', password: await context.password.hash(password) })
    const login = await auth.api.signInEmail({ body: { email: user + '@example.invalid', password }, headers: new Headers({ origin }), returnHeaders: true })
    const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    assert.ok(cookie)
    return cookie
  }
  const ownerCookie = await login(owner), memberCookie = await login(member)
  function session<T>(work: () => Promise<T>, cookie = ownerCookie, workspaceId = space.id) {
    const request = new Request(origin, { headers: { cookie, [WORKSPACE_SELECTION_HEADER]: workspaceId } })
    return runRequestScope(createRequestScope(request), work)
  }
  const chat = { kind: 'chat' as const, id }, run = { kind: 'run' as const, id }
  const pin = { field: 'pinned' as const, value: true }, archive = { field: 'archived' as const, value: true }
  const missing = { error: 'runNotFound' }
  for (const target of [id, chat, run]) {
    assert.ok(desktopActionSchemas['task-runs.renameConversation'].safeParse([target, 'Title']).success)
    assert.ok(desktopActionSchemas['task-runs.regenerateConversationTitle'].safeParse([target]).success)
    assert.ok(desktopActionSchemas['task-runs.readConversationOrganization'].safeParse([target]).success)
    assert.ok(desktopActionSchemas['task-runs.setConversationOrganization'].safeParse([target, pin]).success)
  }
  await reader.query(`INSERT INTO agent_runs(id,"userId","workspaceId","agentId",status,prompt,"promptTaskStart","promptTaskLength")
    VALUES($1,$2,$3,$4,'running','Run source',0,10)`, [id, owner, space.id, agent])
  assert.deepEqual(await session(() => renameConversation(id, 'Run only')), { title: 'Run only' })
  assert.deepEqual(await session(() => renameConversation(chat, 'Wrong chat')), missing)
  await reader.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy","creationPurpose")
    VALUES($1,$2,'group','Chat original',$3,'conversation')`, [id, space.id, owner])
  await reader.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role)
    VALUES($1,'user',$2,'owner'),($1,'user',$3,'member')`, [id, owner, member])
  assert.deepEqual(await session(() => renameConversation(id, 'Ambiguous')), missing)
  assert.deepEqual(await session(() => regenerateConversationTitle(id)), missing)
  assert.equal(await session(() => readConversationOrganization(id)), null)
  assert.equal(await session(() => setConversationOrganization(id, pin)), null)
  assert.deepEqual(calls, [])
  assert.deepEqual(await session(() => renameConversation(chat, 'Chat renamed')), { title: 'Chat renamed' })
  assert.deepEqual(await session(() => setConversationOrganization(chat, pin)), { archived: false, pinned: true })
  assert.deepEqual(await session(() => setConversationOrganization(run, archive)), { archived: true, pinned: false })
  assert.deepEqual(await session(() => readConversationOrganization(chat)), { archived: false, pinned: true })
  assert.deepEqual(await session(() => readConversationOrganization(run)), { archived: true, pinned: false })
  assert.deepEqual(await session(() => regenerateConversationTitle(chat)), { title: 'Chat generated', regenerated: true })
  assert.deepEqual(await session(() => regenerateConversationTitle(run)), { title: 'Run generated', regenerated: true })
  assert.deepEqual(calls, ['Chat renamed', 'Run source'])
  for (const [cookie, workspace] of [[memberCookie, space.id], [ownerCookie, second.id]] as const) {
    for (const target of [run, chat]) {
      assert.deepEqual(await session(() => renameConversation(target, 'Wrong target'), cookie, workspace), missing)
      assert.deepEqual(await session(() => regenerateConversationTitle(target), cookie, workspace), missing)
      assert.equal(await session(() => readConversationOrganization(target), cookie, workspace), null)
      assert.equal(await session(() => setConversationOrganization(target, archive), cookie, workspace), null)
    }
  }
  const state = await reader.query(`SELECT r.title AS run,c.title AS chat,r."conversationPinnedAt" IS NULL AS "runUnpinned",
    c."conversationArchivedAt" IS NULL AS "chatUnarchived" FROM agent_runs r JOIN conversations c ON c.id=r.id WHERE r.id=$1`, [id])
  assert.deepEqual(state.rows, [{ run: 'Run generated', chat: 'Chat generated', runUnpinned: true, chatUnarchived: true }])
  assert.equal(calls.length, 2)
  // One accessible Run shares its UUID with a chat whose owner membership ended.
  await reader.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=$2', [id, owner])
  assert.deepEqual(await session(() => renameConversation(chat, 'Denied chat')), missing)
  assert.deepEqual(await session(() => regenerateConversationTitle(chat)), missing)
  assert.equal(await session(() => setConversationOrganization(chat, archive)), null)
  assert.equal(await session(() => readConversationOrganization(chat)), null)
  assert.deepEqual(await session(() => renameConversation(id, 'Visible run')), { title: 'Visible run' })
  assert.deepEqual((await reader.query('SELECT title FROM conversations WHERE id=$1', [id])).rows, [{ title: 'Chat generated' }])
  await reader.query('UPDATE conversation_members SET "leftAt"=NULL WHERE "conversationId"=$1 AND "memberId"=$2', [id, owner])
  // The still authorized chat remains selectable if the colliding Run belongs to a different workspace.
  await reader.query('DELETE FROM agent_runs WHERE id=$1', [id])
  await reader.query(`INSERT INTO agent_runs(id,"userId","workspaceId","agentId",status,title,"titleSource")
    VALUES($1,$2,$3,$4,'running','Other workspace','manual')`, [id, owner, second.id, agent])
  assert.deepEqual(await session(() => renameConversation(run, 'Denied run')), missing)
  assert.deepEqual(await session(() => regenerateConversationTitle(run)), missing)
  assert.equal(await session(() => setConversationOrganization(run, pin)), null)
  assert.equal(await session(() => readConversationOrganization(run)), null)
  assert.deepEqual((await reader.query('SELECT title FROM agent_runs WHERE id=$1', [id])).rows, [{ title: 'Other workspace' }])
  assert.equal(calls.length, 2)
  await reader.query('DELETE FROM agent_runs WHERE id=$1', [id])
  assert.deepEqual(await session(() => renameConversation(run, 'Wrong run')), missing)
  assert.deepEqual(await session(() => renameConversation(id, 'Legacy chat')), { title: 'Legacy chat' })
})
