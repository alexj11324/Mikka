import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { changeEnabledModels, readEnabledModels, hostedModelEnabled } from './enabled-models'
import { executionModelOptions, executionBinding } from './execution-model-options'
import { setBotApiKeyChoice, usableApiKeys } from './model-api-keys'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Enabled models require isolated PostgreSQL')
test('migration, toggles, source ownership, fresh keys, dispatch filters and row-lock refresh', { skip: !url }, async () => {
  const target = new URL(url!)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.match(target.pathname, /^\/[a-z0-9_]+_e2e$/)
  const schema = 'enabled_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 3 })
  const source = randomUUID(), key = randomUUID(), binding = randomUUID(), workspaceId = randomUUID()
  const scope = { ownerId: 'owner', workspaceId }
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      INSERT INTO "user" VALUES ('owner'),('other');
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text NOT NULL,"modelCatalog" jsonb,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now(),"removedAt" timestamptz,epoch bigint DEFAULT 1,state text DEFAULT 'connected',paused boolean DEFAULT false,provider text DEFAULT 'claude',"accountLabel" text,quota jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"consumerId" text,"workspaceId" text,"modelId" text,route text,"connectionId" uuid,"connectionRevision" bigint,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE model_api_keys (id uuid PRIMARY KEY,"ownerId" text,models jsonb,"modelsError" text,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE model_order_entries (id uuid DEFAULT gen_random_uuid(),"ownerId" text,"workspaceId" text,"sourceKind" text,"sourceId" uuid,model text)`)
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","modelCatalog","workspaceId") VALUES ($1,'owner',$2,$3)`, [source, { revision: '1', models: ['claude-opus-4-5', 'claude-opus-4-6'] }, workspaceId])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","consumerId","workspaceId","modelId",route,"connectionId","connectionRevision") VALUES ($1,'owner','bot',$2,'claude-opus-4-5','claude_cpa',$3,1)`, [binding, workspaceId, source])
    await pool.query(`INSERT INTO model_api_keys (id,"ownerId",models) VALUES ($1,'owner','["old"]')`, [key])
    await pool.query(await readFile(new URL('../drizzle/20261108120101_enabled_models.sql', import.meta.url), 'utf8'))
    let view = await readEnabledModels(pool, scope)
    assert.equal(view.sources.find(item => item.id === source)?.enabledCount, 2, 'legacy old releases stay available')
    assert.deepEqual(view.sources.find(item => item.id === source)?.models.map(({ id, family }) => ({ id, family })), [
      { id: 'claude-opus-4-5', family: 'Opus' }, { id: 'claude-opus-4-6', family: 'Opus' },
    ], 'raw model IDs and the existing family classification reach the settings API')
    assert.equal(await hostedModelEnabled(pool, scope.ownerId), true)
    await assert.rejects(changeEnabledModels(pool, { ...scope, ownerId: 'other' }, source, { kind: 'all', enabled: false }), /executionModelUnknown/)
    await pool.query(`INSERT INTO model_order_entries ("ownerId","workspaceId","sourceKind","sourceId",model) VALUES ('owner',$1,'subscription',$2,'claude-opus-4-5'),('shared-member',$1,'subscription',$2,'claude-opus-4-5')`, [workspaceId, source])
    await changeEnabledModels(pool, scope, source, { kind: 'model', modelId: 'claude-opus-4-5', enabled: false })
    assert.equal((await pool.query('SELECT * FROM model_order_entries')).rowCount, 0, 'disabled source removed from all preferred lists')
    assert.equal((await executionModelOptions(pool, scope)).length, 0)
    assert.equal(await executionBinding(pool, scope, binding), undefined, 'a saved bot choice cannot bypass the toggle')
    await changeEnabledModels(pool, scope, source, { kind: 'all', enabled: true })
    assert.equal((await executionModelOptions(pool, scope)).length, 1)
    await pool.query(`UPDATE model_api_keys SET models='["old","new"]' WHERE id=$1`, [key])
    view = await readEnabledModels(pool, scope)
    assert.deepEqual(view.sources.find(item => item.id === key)?.models, [{ id: 'old', family: null, enabled: true, fresh: false }, { id: 'new', family: null, enabled: false, fresh: true }])
    const refreshedAt = view.sources.find(item => item.id === key)!.refreshedAt
    assert.ok(refreshedAt && Number.isFinite(Date.parse(refreshedAt)))
    await pool.query(`UPDATE model_api_keys SET models=models,"modelsError"='unavailable',"updatedAt"=now()+interval '1 hour' WHERE id=$1`, [key])
    assert.equal((await readEnabledModels(pool, scope)).sources.find(item => item.id === key)?.refreshedAt, refreshedAt,
      'a failed catalogue refresh must not replace the last successful refresh time')
    await changeEnabledModels(pool, scope, key, { kind: 'seen' })
    assert.equal((await readEnabledModels(pool, scope)).sources.find(item => item.id === key)?.freshCount, 0)
    assert.equal((await readEnabledModels(pool, scope)).sources.find(item => item.id === key)?.refreshedAt, refreshedAt, 'marking seen is not a catalogue refresh')
    await changeEnabledModels(pool, scope, key, { kind: 'model', modelId: 'new', enabled: true })
    const writer = await pool.connect()
    await writer.query('BEGIN')
    await writer.query(`SELECT id FROM model_api_keys WHERE id=$1 FOR UPDATE`, [key])
    const toggle = changeEnabledModels(pool, scope, key, { kind: 'model', modelId: 'new', enabled: false })
    await writer.query(`UPDATE model_api_keys SET models='["old","new","newer"]' WHERE id=$1`, [key])
    await writer.query('COMMIT'); writer.release()
    await toggle
    const result = (await readEnabledModels(pool, scope)).sources.find(item => item.id === key)!
    assert.deepEqual(result.models.find(item => item.id === 'new'), { id: 'new', family: null, enabled: false, fresh: false })
    assert.deepEqual(result.models.find(item => item.id === 'newer'), { id: 'newer', family: null, enabled: false, fresh: true })
    await pool.query(`ALTER TABLE model_api_keys ADD COLUMN provider text DEFAULT 'deepseek', ADD COLUMN name text,
      ADD COLUMN "baseUrl" text, ADD COLUMN protocol text DEFAULT 'anthropic', ADD COLUMN last4 text DEFAULT 'test',
      ADD COLUMN "responsesApi" boolean DEFAULT true;
      CREATE TABLE workspace_personal_policies ("workspaceId" text,subscriptions boolean)`)
    await pool.query('INSERT INTO workspace_personal_policies VALUES ($1,false)', [workspaceId])
    // Use the canonical sharing schema for the real usable-key read below.
    await pool.query(await readFile(new URL('../drizzle/20261101021000_model_api_keys.sql', import.meta.url), 'utf8'))
    assert.deepEqual((await usableApiKeys(pool, scope.ownerId, workspaceId))[0].models, ['old'])
    await changeEnabledModels(pool, scope, key, { kind: 'all', enabled: false })
    assert.deepEqual((await usableApiKeys(pool, scope.ownerId, workspaceId))[0].models, [])
    await assert.rejects(setBotApiKeyChoice(pool, scope, null, key, 'old'), /executionModelUnknown/,
      'an entirely disabled catalogue must not be mistaken for an unrestricted custom key')
    await changeEnabledModels(pool, scope, 'hosted', { kind: 'all', enabled: false })
    assert.equal(await hostedModelEnabled(pool, scope.ownerId), false)
    assert.equal(await hostedModelEnabled(pool, 'other'), true)
    await assert.rejects(changeEnabledModels(pool, scope, key, { kind: 'auto', enabled: true }), /validationGeneric/)
    await assert.rejects(changeEnabledModels(pool, scope, key, { kind: 'model', modelId: 'absent', enabled: true }), /executionModelUnknown/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
