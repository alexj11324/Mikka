import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'
import { disposableDatabase } from './helpers/e2e-target.mjs'

if (dbUrl && !disposableDatabase(process.env, dbUrl)) throw Error('Model gateway DB tests require isolated loopback *_e2e targets')

// Decision 2026-11-15-2000: a run's CLI holds only a gateway token. It is bound
// to that run and stops working when the run is no longer active or it expires.
test('a gateway token is stored hashed and lives only as long as its run', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { mintGatewayToken, verifyGatewayToken, hashGatewayToken, GATEWAY_TOKEN_TTL_MS } = await import('../lib/model-gateway/token')
  const users: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM model_gateway_tokens WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    } finally { await pool.end() }
  })
  const ownerId = await seedUser(pool, 'model-gateway-token'); users.push(ownerId)
  const agentId = randomUUID(), runId = randomUUID()
  await pool.query('INSERT INTO agents (id,"userId",harness,name) VALUES ($1,$2,$3,$4)', [agentId, ownerId, 'claude_code', 'Claude Code'])
  await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,$4)', [runId, ownerId, agentId, 'running'])
  const grant = { runId, ownerId, workspaceId: null, harness: 'claude_code' as const, model: 'anthropic/claude-sonnet-5.5', source: { kind: 'credits' as const } }

  const { token } = await mintGatewayToken(pool, grant)
  const { rows } = await pool.query('SELECT "tokenHash" FROM model_gateway_tokens WHERE "runId"=$1', [runId])
  assert.deepEqual(rows.map(row => row.tokenHash), [hashGatewayToken(token)], 'only the hash is kept')
  assert.deepEqual(await verifyGatewayToken(pool, token), grant)
  assert.equal(await verifyGatewayToken(pool, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null, 'a different token')
  assert.equal(await verifyGatewayToken(pool, 'sk-not-a-gateway-token'), null)
  assert.equal(await verifyGatewayToken(pool, token, new Date(Date.now() + GATEWAY_TOKEN_TTL_MS + 1000)), null, 'expired')

  const keyId = randomUUID()
  const keyed = await mintGatewayToken(pool, { ...grant, model: 'deepseek-chat', source: { kind: 'api_key', keyId } })
  assert.deepEqual((await verifyGatewayToken(pool, keyed.token))?.source, { kind: 'api_key', keyId })

  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  assert.equal(await verifyGatewayToken(pool, token), null, 'a stop request ends the token')
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL,status=$2 WHERE id=$1', [runId, 'completed'])
  assert.equal(await verifyGatewayToken(pool, token), null, 'an ended run ends the token')
})
