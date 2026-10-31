import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { PersonalPluginStore } from './store'
import { createMcpSchema, type SkillContent } from './contracts'
import { AgentKitStore } from '@/lib/agent-kit/store'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'

const databaseURL = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw Error('Personal plugin database tests require E2E_DATABASE_URL')
test('real Postgres: personal ownership, encrypted auth, revocation, installation idempotency and immutable execution mounting', { skip: !databaseURL }, async () => {
  const url = new URL(databaseURL!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.endsWith('_e2e') && !url.search && !url.hash, 'Explicit isolated loopback E2E database required')
  const schema = `plugins_${randomBytes(8).toString('hex')}`
  const admin = new Pool({ connectionString: databaseURL }), pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  await admin.query(`CREATE SCHEMA ${schema}`)
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES('owner'),('peer'); CREATE TABLE workspace_app_policies(app text CHECK(app IN ('gmail','notion'))); CREATE TABLE composio_accounts("userId" text,toolkit text); CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,UNIQUE(id,"workspaceId","ownerId")); CREATE TABLE agent_runs(id uuid PRIMARY KEY)`)
    const migration = await readFile(new URL('../../drizzle/20261031040000_personal_plugins.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    const store = new PersonalPluginStore(pool, { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
    const secret = randomBytes(24).toString('base64url')
    const server = await store.createMcp('owner', createMcpSchema.parse({ name: 'Personal', url: 'https://mcp.acme.dev/rpc', auth: { name: 'Authorization', value: `Bearer ${secret}` } }))
    assert.ok(!JSON.stringify(server).includes(secret)); assert.equal(server.authKind, 'header')
    assert.deepEqual(await store.listMcp('peer'), [])
    await assert.rejects(store.updateMcp('peer', { id: server.id, enabled: false }), /mcpNotFound/)
    await assert.rejects(store.deleteMcp('peer', server.id), /mcpNotFound/)
    await assert.rejects(store.mcpConnection('peer', server.id), /mcpUnavailable/)
    assert.equal((await store.mcpConnection('owner', server.id)).headers.authorization, `Bearer ${secret}`)
    const stored = (await pool.query('SELECT ciphertext FROM personal_mcp_servers WHERE id=$1', [server.id])).rows[0]
    assert.ok(stored.ciphertext && !stored.ciphertext.includes(secret))
    await store.updateMcp('owner', { id: server.id, enabled: false })
    await assert.rejects(store.mcpConnection('owner', server.id), /mcpUnavailable/)
    await store.updateMcp('owner', { id: server.id, enabled: true, name: 'Renamed' })
    await assert.rejects(store.mcpConnection('owner', server.id, server.revision), /mcpUnavailable/)
    await store.updateMcp('owner', { id: server.id, auth: null })
    assert.deepEqual((await store.mcpConnection('owner', server.id)).headers, {})
    assert.equal((await pool.query('SELECT ciphertext FROM personal_mcp_servers WHERE id=$1', [server.id])).rows[0].ciphertext, null)
    const skill: SkillContent = { name: 'Example', source: 'owner/skills', slug: 'example', sourceKind: 'skills.sh', sourceRevision: 'a'.repeat(40), sourcePath: 'skills/example/SKILL.md', body: '# Fixed skill', sha256: 'b'.repeat(64) }
    const installed = await store.installSkill('owner', skill)
    assert.equal((await store.installSkill('owner', { ...skill, body: '# Changed upstream' })).id, installed.id)
    assert.equal((await store.listSkills('owner')).length, 1); assert.deepEqual(await store.listSkills('peer'), [])
    await assert.rejects(store.updateSkill('peer', installed.id, false), /skillNotFound/)
    await assert.rejects(store.deleteSkill('peer', installed.id), /skillNotFound/)
    await pool.query(await readFile(new URL('../../drizzle/20261027181000_agent_kit.sql', import.meta.url), 'utf8'))
    const kit = new AgentKitStore(pool), scope = { ownerId: 'owner', botId: null, workspaceId: null }
    // A deliberately narrow pre-existing definition is not rewritten by installations.
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: ['web_search'] as typeof DEFAULT_AGENT_DEFINITION.tools }
    await pool.query('INSERT INTO composio_accounts VALUES($1,$2)', ['owner', 'googledrive'])
    const execution = await kit.beginExecution(scope, 'first', 'host', { harness: 'ai_sdk', model: 'synthetic' }, definition, client => store.snapshot('owner', client))
    assert.equal(execution.snapshot.personalPlugins?.skills[0].body, skill.body)
    assert.ok(execution.snapshot.effectiveTools.includes('call_personal_mcp_tool'))
    assert.ok(execution.snapshot.effectiveTools.includes('list_drive_files'))
    assert.deepEqual(execution.snapshot.definition.tools, ['web_search'])
    const saved = JSON.stringify(execution.snapshot)
    await store.updateSkill('owner', installed.id, false)
    await store.updateMcp('owner', { id: server.id, enabled: false })
    const replay = await kit.beginExecution(scope, 'first', 'new host', { harness: 'ai_sdk', model: 'changed' }, definition, async () => { throw Error('Must not refresh a replay') })
    assert.deepEqual(replay.snapshot, execution.snapshot); assert.equal(JSON.stringify(execution.snapshot), saved)
    const next = await kit.beginExecution(scope, 'second', 'host', { harness: 'ai_sdk', model: 'synthetic' }, definition, client => store.snapshot('owner', client))
    assert.deepEqual(next.snapshot.personalPlugins?.skills, []); assert.deepEqual(next.snapshot.personalPlugins?.servers, [])
    assert.ok(!next.snapshot.effectiveTools.includes('call_personal_mcp_tool'))
    await store.deleteSkill('owner', installed.id); await store.deleteMcp('owner', server.id)
    assert.deepEqual(await store.listSkills('owner'), []); assert.deepEqual(await store.listMcp('owner'), [])
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
