import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

// 「API 与订阅」 API keys against real Postgres: the migration replays, keys are
// checked with the provider and stored sealed, shares follow the workspace
// rules, and a run gets only a key its owner may use (orchestration.md § 2, § 6).
const databaseURL = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('API key database test URL required')

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const models = (ids: string[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id, object: 'model' })) }), { status: 200, headers: { 'content-type': 'application/json' } })

test('API keys: migration replay, sealed storage, shares, picker order and run injection', { skip: !databaseURL }, async () => {
  const url = new URL(databaseURL!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.ok(url.pathname.endsWith('_e2e'))
  const store = await import('../lib/model-api-keys')
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `api_keys_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      INSERT INTO "user" VALUES ('alice'),('bob'),('carol');
      CREATE TABLE byos_connections ("ownerId" text, "workspaceId" text, "removedAt" timestamptz);
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "botId" uuid, status text NOT NULL)`)
    await pool.query(await readFile(new URL('../drizzle/20261031213105_workspace_personal_policies.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../drizzle/20261101090000_model_api_keys.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    await pool.query(migration)
    assert.equal(await store.apiKeyAfterQuota(pool, 'alice'), true, 'on by default')

    const personal = { id: randomUUID(), kind: 'personal' as const }
    const team = { id: randomUUID(), kind: 'team' as const }
    // A personal workspace always uses its owner's credentials; in the team Alice shared hers, Bob did not.
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2),($3,$4)', ['alice', personal.id, 'alice', team.id])

    // A rejected key is never stored.
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchWith = (response: () => Response) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return response()
    }) as typeof fetch
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: 'sk-wrong-key-0000' }, { env, fetch: fetchWith(() => new Response('{}', { status: 401 })) }), { code: 'apiKeyInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: 'sk-down-key-0000' }, { env, fetch: fetchWith(() => new Response('', { status: 503 })) }), { code: 'apiKeyUnverifiable' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_keys')).rows[0].n, 0)
    assert.equal(calls[0].url, 'https://api.deepseek.com/models')
    assert.equal(calls[0].headers.authorization, 'Bearer sk-wrong-key-0000')

    // A preset key: checked, listed, sealed, last four only.
    const secret = 'sk-ant-real-secret-1234'
    const anthropic = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: secret }, { env, fetch: fetchWith(() => models(['claude-opus-5-5', 'claude-sonnet-5-5'])) })
    assert.equal(calls.at(-1)!.headers['x-api-key'], secret)
    assert.deepEqual({ ...anthropic, id: undefined }, { id: undefined, provider: 'anthropic', name: null, baseUrl: null, protocol: 'anthropic', last4: '1234', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })
    const raw = (await pool.query('SELECT * FROM model_api_keys WHERE id=$1', [anthropic.id])).rows[0]
    assert.ok(!JSON.stringify(raw).includes(secret), 'stored sealed')
    // Adding the same preset again replaces the key in place.
    const replaced = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: 'sk-ant-new-secret-9876' }, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })
    assert.equal(replaced.id, anthropic.id)
    assert.equal(replaced.last4, '9876')

    // Custom providers: https on a public address only; the person's own model list wins.
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'http://example.com/v1', protocol: 'openai', apiKey: 'sk-custom-0000' }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://10.0.0.8/v1', protocol: 'openai', apiKey: 'sk-custom-0000' }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://llm.internal.example/v1', protocol: 'openai', apiKey: 'sk-custom-0000' }, { env, fetch: fetchWith(() => models([])), resolve: async () => ['192.168.1.4'] }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', apiKey: 'sk-custom-0000' }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1', VERCEL: '1' }, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    const gateway = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Gateway', baseUrl: 'https://gateway.example.com/v1/', protocol: 'openai', apiKey: 'sk-gateway-5555', models: ['qwen-max', 'qwen-max'] }, { env, fetch: fetchWith(() => models(['a', 'b'])), resolve: async () => ['93.184.216.34'] })
    assert.equal(calls.at(-1)!.url, 'https://gateway.example.com/v1/models')
    assert.deepEqual([gateway.baseUrl, gateway.protocol, gateway.models], ['https://gateway.example.com/v1', 'openai', ['qwen-max']])
    const local = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:8787', protocol: 'anthropic', apiKey: 'sk-local-7777' }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1' }, fetch: fetchWith(() => models(['glm-5'])) })
    assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:8787/v1/models')

    // Sharing: team workspaces only, the admin switch gates turning it on, others' keys only.
    await assert.rejects(store.setApiKeyShare(pool, 'bob', personal, gateway.id, true), { code: 'validationGeneric' })
    await assert.rejects(store.setApiKeyShare(pool, 'carol', team, gateway.id, true), { code: 'apiKeyNotFound' })
    await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [team.id])
    await assert.rejects(store.setApiKeyShare(pool, 'bob', team, gateway.id, true), { code: 'workspaceAccessDenied' })
    assert.equal((await store.listApiKeys(pool, 'bob', team)).canShare, false)
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [team.id])
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, true)
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, true)
    const bobPage = await store.listApiKeys(pool, 'bob', team)
    assert.deepEqual(bobPage.keys.map(key => [key.name, key.shared]), [['Gateway', true], ['Local', false]])
    assert.equal(bobPage.canShare, true)
    assert.ok(!JSON.stringify(bobPage).includes('sk-'), 'views never carry the key')

    // The picker: own keys first when allowed here, then teammates' shared keys.
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.provider, key.mine]), [['anthropic', true], ['custom', false]])
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id)).map(key => key.name), [], 'Bob did not share his own credentials here, and nobody shared with him')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', personal.id)).map(key => key.provider), ['anthropic'])
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=false WHERE "workspaceId"=$1', [team.id])
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id), [], 'the admin switch turns off members\' credentials')
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [team.id])

    // Run injection: only an active run whose owner may use the key here.
    const teamBot = randomUUID(), personalBot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2),($3,$4)', [teamBot, team.id, personalBot, personal.id])
    const run = randomUUID(), done = randomUUID(), carolRun = randomUUID(), loose = randomUUID()
    await pool.query(`INSERT INTO agent_runs VALUES ($1,'alice',$2,'running'),($3,'alice',$2,'succeeded'),($4,'carol',$2,'queued'),($5,'bob',NULL,'running')`, [run, teamBot, done, carolRun, loose])
    const claude = await store.apiKeyForRun(pool, run, anthropic.id, env)
    assert.deepEqual(claude, { harness: 'claude_code', keyId: anthropic.id, ownerId: 'alice', env: { ANTHROPIC_API_KEY: 'sk-ant-new-secret-9876', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const codex = await store.apiKeyForRun(pool, run, gateway.id, env)
    assert.equal(codex.harness, 'codex')
    assert.deepEqual(codex.harness === 'codex' && [codex.env, codex.codex.model_providers.mikka], [{ MIKKA_MODEL_API_KEY: 'sk-gateway-5555' }, { name: 'Gateway', base_url: 'https://gateway.example.com/v1', env_key: 'MIKKA_MODEL_API_KEY', wire_api: 'chat' }])
    await assert.rejects(store.apiKeyForRun(pool, done, anthropic.id, env), { code: 'apiKeyNotFound' }, 'finished runs get nothing')
    await assert.rejects(store.apiKeyForRun(pool, carolRun, anthropic.id, env), { code: 'apiKeyNotFound' }, 'Alice did not share her key with the team')
    assert.equal((await store.apiKeyForRun(pool, carolRun, gateway.id, env)).ownerId, 'bob', 'Bob shared his with the team')
    assert.equal((await store.apiKeyForRun(pool, loose, local.id, env)).harness, 'claude_code', 'a run without a bot may use its owner\'s own key')
    await assert.rejects(store.apiKeyForRun(pool, loose, anthropic.id, env), { code: 'apiKeyNotFound' })
    // Withdrawing the share stops the next run from getting the key.
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, false)
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, env), { code: 'apiKeyNotFound' })
    // A copied ciphertext does not open on another row.
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, true)
    await pool.query('UPDATE model_api_keys SET ciphertext=(SELECT ciphertext FROM model_api_keys WHERE id=$1), iv=(SELECT iv FROM model_api_keys WHERE id=$1) WHERE id=$2', [local.id, gateway.id])
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, env), { code: 'apiKeyNotFound' })

    // A member leaving takes their shares; removing a key removes its shares.
    await store.removeMemberApiKeyShares(pool, 'bob', team.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)
    await store.setApiKeyShare(pool, 'bob', team, local.id, true)
    assert.deepEqual(await store.removeApiKey(pool, 'alice', local.id), { removed: false }, 'only the owner removes a key')
    assert.deepEqual(await store.removeApiKey(pool, 'bob', local.id), { removed: true })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)

    await store.setApiKeyAfterQuota(pool, 'alice', false)
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).apiKeyAfterQuota, false)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
