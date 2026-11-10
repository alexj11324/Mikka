// Workspace app permissions through the same settings object the definition
// route wires (`createWritePolicySettings` + the real membership lease), against
// a real PostgreSQL. Members read; only an admin saves; a save lands in the
// workspace the request names. The GitHub gate reads the stored layers.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWritePolicySettings } from './write-policy-settings'
import { githubCallAllowed, githubCallDecision } from './github-call-policy'
import { appPermissionValue, withAppPermission } from './app-permission-keys'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

const settingsFor = async (pool: import('pg').Pool) => {
  const { workspacePool } = await import('../workspace-db')
  const { acquireWorkspaceMembership } = await import('../workspace-membership-guard')
  // This is the guard the definition route passes: the workspace named by the
  // Bot scope, with the caller's membership and admin role re-checked in the transaction.
  return createWritePolicySettings(pool, scope => scope.workspaceId
    ? (_tx, signal) => acquireWorkspaceMembership(workspacePool, { workspaceId: scope.workspaceId!, userId: scope.ownerId }, signal)
    : undefined)
}

test('workspace app permissions', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const { AgentKitError } = await import('../agent-kit/store')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { workspacePool } = await import('../workspace-db')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
  const settings = await settingsFor(pool)
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: unknown) => error instanceof AgentKitError && error.code === code)

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const bot = await seedBot(pool, ws.id, admin), memberBot = await seedBot(pool, ws.id, member), otherBot = await seedBot(pool, other.id, admin)
  // The GitHub gate joins the workspace policy through this Bot's AgentKit head.
  await pool.query('insert into agent_kit_heads(owner_id,bot_key,workspace_id) values($1,$2,$3),($4,$5,$6),($7,$8,$9)',
    [admin, bot, ws.id, member, memberBot, ws.id, admin, otherBot, other.id])
  const workspaceScope = { ownerId: admin, botId: bot, workspaceId: ws.id }
  const memberScope = { ownerId: member, botId: bot, workspaceId: ws.id }
  const otherScope = { ownerId: admin, botId: otherBot, workspaceId: other.id }

  await t.test('a member reads the workspace policy but cannot save it', async () => {
    assert.deepEqual(await settings.readWorkspace(memberScope), { permissions: {}, version: '0' })
    await rejects(settings.setWorkspace(memberScope, { slack: 'deny' }, '0'), 'workspaceAccessDenied')
    assert.deepEqual(await settings.readWorkspace(memberScope), { permissions: {}, version: '0' })
  })

  await t.test('an admin saves an app on both the app and legacy write keys', async () => {
    const saved = withAppPermission({}, 'slack', 'deny')
    assert.deepEqual(await settings.setWorkspace(workspaceScope, saved, '0'), { permissions: saved, version: '1' })
    const read = await settings.readWorkspace(workspaceScope)
    assert.equal(appPermissionValue(read.permissions, 'slack'), 'deny')
    assert.equal(read.permissions.send_slack_message, 'deny')
  })

  await t.test('a save lands in the workspace the request names, not another one', async () => {
    assert.deepEqual(await settings.readWorkspace(otherScope), { permissions: {}, version: '0' })
    await settings.setWorkspace(otherScope, { slack: 'allow' }, '0')
    assert.equal(appPermissionValue((await settings.readWorkspace(otherScope)).permissions, 'slack'), 'allow')
    assert.equal(appPermissionValue((await settings.readWorkspace(workspaceScope)).permissions, 'slack'), 'deny')
  })

  await t.test('the GitHub gate follows the stored workspace layer only', async () => {
    assert.equal(await githubCallAllowed(admin, bot), true)
    await settings.setWorkspace(workspaceScope, { ...(await settings.readWorkspace(workspaceScope)).permissions, github: 'deny' }, '1')
    assert.equal(await githubCallAllowed(admin, bot), false)
    // Another workspace's policy does not govern this Bot.
    assert.equal(await githubCallAllowed(admin, otherBot), true)
    // A Bot head deny cannot narrow a workspace allow.
    await pool.query('update agent_kit_heads set external_write_permissions=$3 where owner_id=$1 and bot_key=$2', [admin, bot, { github: 'deny' }])
    await settings.setWorkspace(workspaceScope, { github: 'allow' }, '2')
    assert.equal(await githubCallAllowed(admin, bot), true)
  })

  await t.test('the definition route rejects a member save and accepts an admin save', async () => {
    const { createAgentDefinitionHandler } = await import('../agent-kit/http')
    const { agentKitDefaults, agentKitStore, agentScope } = await import('../agent-kit/service')
    const handler = createAgentDefinitionHandler({
      enabled: () => true,
      authenticate: async request => request.headers.get('x-test-owner'),
      scope: async (ownerId, botId) => agentScope(ownerId, botId),
      store: agentKitStore,
      writePolicy: { enabled: () => true, settings },
      defaults: agentKitDefaults(),
      evaluate: async () => ({}),
    })
    const command = (ownerId: string, botId: string, permissions: unknown, expectedVersion: string) => new Request(`https://fixture.invalid/api/bots/${botId}/definition`, {
      method: 'POST',
      headers: { origin: 'https://fixture.invalid', 'content-type': 'application/json', 'x-test-owner': ownerId },
      body: JSON.stringify({ action: 'set_workspace_write_policy', permissions, expectedVersion }),
    })
    const version = (await settings.readWorkspace(workspaceScope)).version
    const denied = await handler(command(member, memberBot, { slack: 'allow' }, version), memberBot)
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { error: 'workspaceAccessDenied' })
    assert.equal(appPermissionValue((await settings.readWorkspace(workspaceScope)).permissions, 'slack'), 'deny')
    const saved = await handler(command(admin, bot, { slack: 'ask' }, version), bot)
    assert.equal(saved.status, 200)
    assert.equal(appPermissionValue((await settings.readWorkspace(workspaceScope)).permissions, 'slack'), 'ask')
  })

  await t.test('a malformed workspace layer fails closed', async () => {
    await pool.query('update workspace_computer_policies set external_write_permissions=$2 where "workspaceId"=$1', [ws.id, { github: 'maybe' }])
    assert.equal(await githubCallDecision(admin, bot), 'unavailable')
    assert.equal(await githubCallAllowed(admin, bot), false)
  })
})
