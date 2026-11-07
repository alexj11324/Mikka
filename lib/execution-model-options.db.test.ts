import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { ExecutionSettings } from './execution-settings'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Execution model read tests require isolated PostgreSQL')

test('catalogue reads deduplicate in PostgreSQL, page without losing microseconds, and retain exact saved bindings', { skip: !url }, async t => {
  const target = new URL(url!)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.match(target.pathname, /^\/[a-z0-9_]+_e2e$/)
  const admin = new Pool({ connectionString: url, max: 1 })
  const schema = 'model_reads_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })
  try {
    await pool.query(`CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,epoch bigint,state text,paused boolean,provider text,"accountLabel" text,quota jsonb,"modelCatalog" jsonb,"removedAt" timestamptz);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"consumerId" text,"workspaceId" text,"modelId" text,route text,"connectionId" uuid,"connectionRevision" bigint,"createdAt" timestamptz)`)
    const scope = { ownerId: 'reader', workspaceId: randomUUID() }
    const elsewhere = randomUUID(), connection = randomUUID(), foreign = randomUUID()
    const quota = { plan: 'Fixture', status: 'ok', windows: [{ kind: 'five_hour', used: 0.1, resetsAt: '2026-11-05T15:00:00Z' }], observedAt: '2026-11-05T11:00:00Z', vendor: 'codex', source: 'official' }
    await pool.query(`INSERT INTO byos_connections VALUES ($1,'reader',1,'connected',false,'codex','Synthetic account',$3,NULL),($2,'other',1,'connected',false,'claude','Private other',$3,NULL)`, [connection, foreign, quota])
    await pool.query(`INSERT INTO byos_bindings
      SELECT gen_random_uuid(),'reader','copy-'||copy,CASE WHEN copy=0 THEN $2 ELSE $3 END,'model-'||lpad(model::text,3,'0'),'codex_cpa',$1,1,
        timestamptz '2026-11-05T00:00:00Z'+(model*3+copy)*interval '1 microsecond'
      FROM generate_series(0,130) model CROSS JOIN generate_series(0,2) copy`, [connection, scope.workspaceId, elsewhere])
    await pool.query(`INSERT INTO byos_bindings VALUES (gen_random_uuid(),'other','foreign',$1,'private-model','claude_cpa',$2,1,now())`, [scope.workspaceId, foreign])
    const legacy = (await pool.query(`SELECT b.id AS "bindingId",b."ownerId",b."consumerId",b."workspaceId",b."modelId",b.route,c.id AS "connectionId",c.provider,c."accountLabel",c.quota->>'plan' AS plan,c.quota
      FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
      AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false
      WHERE b."ownerId"=$1 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc')
      AND (c."modelCatalog" IS NULL OR c."modelCatalog"->>'revision'<>c.epoch::text OR c."modelCatalog"->'models' ? b."modelId")
      ORDER BY (b."workspaceId"=$2) DESC,b."createdAt" DESC,b.id`, [scope.ownerId, scope.workspaceId])).rows
    const seen = new Set<string>()
    const expected = legacy.filter(row => { const key = JSON.stringify([row.connectionId, row.modelId]); if (seen.has(key)) return false; seen.add(key); return true })
    const reads: { rows: number; bytes: number }[] = []
    const measured = { query: async (sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params)
      reads.push({ rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result.rows)) })
      return result
    } } as unknown as Pool
    const settings = new ExecutionSettings(measured)
    const options = await settings.botModels(scope)
    assert.deepEqual(options, expected, 'same preferred workspace, newest binding and stable tie order')
    assert.ok(reads.every(read => read.rows <= 128), 'each database result is a bounded page, including duplicate Bot copies')
    assert.equal(reads.length, 2, '131 models require two bounded reads without truncating the catalogue')
    const fullBytes = reads.reduce((sum, read) => sum + read.bytes, 0)
    reads.length = 0
    const candidates = await settings.modelCandidates(scope)
    assert.deepEqual(candidates, expected.map(({ ownerId, modelId, connectionId, provider }) => ({ ownerId, modelId, connectionId, provider })))
    assert.ok(reads.every(read => read.rows <= 128))
    const catalogueBytes = reads.reduce((sum, read) => sum + read.bytes, 0)
    const before = Buffer.byteLength(JSON.stringify(legacy))
    assert.ok(fullBytes < before / 2)
    assert.ok(catalogueBytes < before / 3)
    t.diagnostic(JSON.stringify({ beforeRows: legacy.length, afterRows: options.length, beforeBytes: before, fullOptionBytes: fullBytes, catalogueBytes, cataloguePages: reads.length, maxPageRows: Math.max(...reads.map(read => read.rows)) }))
    const hidden = legacy.find(row => row.consumerId === 'copy-1')!
    assert.deepEqual(await settings.botBinding(scope, hidden.bindingId), hidden, 'an exact saved binding remains usable outside the catalogue winner')
    assert.equal(await settings.botBinding({ ...scope, ownerId: 'other' }, hidden.bindingId), undefined)
    await pool.query(`UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1`, [connection, { revision: '1', models: ['model-000'] }])
    assert.deepEqual((await settings.botModels(scope)).map(row => row.modelId), ['model-000'])
    assert.deepEqual(await settings.botBinding(scope, hidden.bindingId), hidden, 'saved lookup remains independent of a changed catalogue')
    await pool.query(`UPDATE byos_connections SET paused=true WHERE id=$1`, [connection])
    assert.deepEqual(await settings.botModels(scope), [])
    assert.equal(await settings.botBinding(scope, hidden.bindingId), undefined)
    await pool.query(`UPDATE byos_connections SET paused=false,epoch=2 WHERE id=$1`, [connection])
    assert.deepEqual(await settings.botModels(scope), [], 'stale revisions remain unavailable')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
