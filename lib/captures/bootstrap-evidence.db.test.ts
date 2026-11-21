import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { resolveAgentSettings } from '@mikka/protocol/agent-policy'
import type { WorkerDefinitionSnapshot } from '../agent-kit/worker'
import { anonymousStartupHint } from '../computer/anonymous-startup-hint'
import { readRunBootstrapEvidence } from './bootstrap-evidence'

const url = process.env.E2E_DATABASE_URL
const allowed = disposableDatabase(process.env, url)
if (process.env.REQUIRE_DB === '1' && !allowed) throw Error('Isolated loopback test database required')

test('bootstrap projection uses one read-only authorized snapshot and rejects stale or foreign resources', { skip: !allowed }, async t => {
  const admin = new Pool({ connectionString: url }), schema = 'bootstrap_evidence_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema })
  const runId = randomUUID(), deviceId = randomUUID(), workspaceId = randomUUID(), botId = randomUUID(), repoId = randomUUID(), bindingId = randomUUID()
  const owner = 'candidate-owner', rawBootstrap = 'fixture-private-bootstrap', digest = createHash('sha256').update(rawBootstrap).digest('hex')
  const input = { bootstrap: '1' as const, deviceId, workspaceId, bootstrapSha256: digest }
  const identity = { version: 1, requester: owner, executionPrincipal: owner, outputOwner: owner, botId, botOwner: owner, workspaceId,
    personalResourcePolicy: 'requester_only', resourceBindings: [
      { kind: 'device', id: deviceId, ownerId: owner, access: 'owner' },
      { kind: 'subscription', id: bindingId, ownerId: 'shared-owner', access: 'workspace_share', revision: '1' }],
    billingAccount: { model: { kind: 'subscription', ownerId: 'shared-owner', resourceId: bindingId, amount: 'provider_unknown' },
      runtime: { kind: 'local_device', ownerId: owner, resourceId: deviceId, amount: 'not_applicable' } } }
  const definition = (harness: 'claude_code' | 'codex') => ({
    schemaVersion: 1, kind: 'worker', harness, modelSource: 'subscription', cliModelSelection: 'explicit',
    model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', readOnly: true,
    subscription: { bindingId, modelId: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5',
      route: harness === 'codex' ? 'codex_cli' : 'claude_code_cli' },
    policyCeiling: resolveAgentSettings(null, null, 'cloud').policy, agentProfile: { effort: 'low' },
    mailbox: { tools: ['mailbox_inbox'] }, executionIdentity: identity,
    instructions: 'PRIVATE_INSTRUCTIONS_MUST_NOT_BE_SELECTED', modelCredential: { secret: 'PRIVATE_CREDENTIAL_MUST_NOT_BE_SELECTED' },
  }) as unknown as WorkerDefinitionSnapshot
  try {
    // Same relevant column types as the tracked schema; no production database.
    await pool.query('CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text NOT NULL,enabled boolean NOT NULL,"removedAt" timestamptz);' +
      'CREATE TABLE device_repos(id uuid PRIMARY KEY,"deviceId" uuid NOT NULL,"userId" text NOT NULL,"repoPath" text NOT NULL);' +
      'CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL,"archivedAt" timestamptz);' +
      'CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text NOT NULL,"botId" uuid,"deviceId" uuid,"deviceRepoId" uuid,kind text,status text,attempt integer,' +
      '"startedAt" timestamptz,"sessionId" text,"deviceTokenId" uuid,"retryOf" uuid,"continuesRunId" uuid,"questionContinuation" jsonb,"stopRequestedAt" timestamptz,"agentDefinition" jsonb)')
    await pool.query('INSERT INTO devices VALUES($1,$2,true,NULL)', [deviceId, owner])
    await pool.query('INSERT INTO device_repos VALUES($1,$2,$3,$4)', [repoId, deviceId, owner, 'v2/github.com/alexj11324/mikka-handoff'])
    await pool.query('INSERT INTO bots VALUES($1,$2,$3,NULL)', [botId, owner, workspaceId])
    await pool.query('INSERT INTO agent_runs(id,"userId","botId","deviceId","deviceRepoId",kind,status,attempt,"agentDefinition") VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)',
      [runId, owner, botId, deviceId, repoId, 'implement', 'queued', JSON.stringify(definition('claude_code'))])
    for (const harness of ['claude_code', 'codex'] as const) await t.test(harness + ' matches the real server builder without private columns', async () => {
      const d = definition(harness)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$1', [JSON.stringify(d)])
      const client = await pool.connect()
      try {
        await client.query('BEGIN READ ONLY')
        const rows = await readRunBootstrapEvidence(client, owner, runId, input)
        assert.deepEqual(rows?.hint, JSON.parse(anonymousStartupHint({ runId, bootstrap: rawBootstrap, kind: 'implement',
          repository: 'v2/github.com/alexj11324/mikka-handoff', userId: owner, botId, freshTask: true, diagnostics: true, definition: d })))
        assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|bindingId|shared-owner|credential|instructions/i)
      } finally { await client.query('ROLLBACK'); client.release() }
    })
    for (const [name, sql, values] of [
      ['run owner', 'UPDATE agent_runs SET "userId"=$1', ['foreign-owner']],
      ['device owner', 'UPDATE devices SET "ownerId"=$1', ['foreign-owner']],
      ['device disabled', 'UPDATE devices SET enabled=false', []],
      ['device removed', 'UPDATE devices SET "removedAt"=now()', []],
      ['repository owner', 'UPDATE device_repos SET "userId"=$1', ['foreign-owner']],
      ['repository device', 'UPDATE device_repos SET "deviceId"=$1', [randomUUID()]],
      ['bot owner', 'UPDATE bots SET "ownerId"=$1', ['foreign-owner']],
      ['bot workspace', 'UPDATE bots SET "workspaceId"=$1', [randomUUID()]],
      ['bot archived', 'UPDATE bots SET "archivedAt"=now()', []],
      ['already claimed', 'UPDATE agent_runs SET "deviceTokenId"=$1', [randomUUID()]],
      ['already started', 'UPDATE agent_runs SET "startedAt"=now()', []],
      ['old native session', 'UPDATE agent_runs SET "sessionId"=$1', ['previous-native-session']],
      ['retry', 'UPDATE agent_runs SET attempt=2', []],
      ['continuation', 'UPDATE agent_runs SET "continuesRunId"=$1', [randomUUID()]],
      ['stop', 'UPDATE agent_runs SET "stopRequestedAt"=now()', []],
      ['different kind', 'UPDATE agent_runs SET kind=$1', ['review']],
      ['non-readonly', 'UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{readOnly}\',\'false\'::jsonb)', []],
      ['foreign frozen workspace', 'UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{executionIdentity,workspaceId}\',to_jsonb($1::text))', [randomUUID()]],
    ] satisfies [string, string, unknown[]][]) await t.test('rejects ' + name, async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); await client.query(sql, values)
        assert.equal(await readRunBootstrapEvidence(client, owner, runId, input), null)
      } finally { await client.query('ROLLBACK'); client.release() }
    })
    assert.equal(await readRunBootstrapEvidence(pool, owner, runId, { ...input, deviceId: randomUUID() }), null)
    assert.equal(await readRunBootstrapEvidence(pool, owner, runId, { ...input, workspaceId: randomUUID() }), null)
  } finally {
    await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
    assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0)
    await admin.end()
  }
})
