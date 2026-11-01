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
// Fake keys made per run, so no key-shaped literal sits in the repository.
const fakeKey = (label: string) => `test-${label}-${randomBytes(12).toString('hex')}`
const [wrongKey, downKey, firstKey, newKey, customKey, gatewayKey, localKey] = ['wrong', 'down', 'first', 'new', 'custom', 'gateway', 'local'].map(fakeKey)
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
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "ownerId" text);
      CREATE TABLE bot_model_choices ("ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, "botKey" text NOT NULL, "bindingId" uuid, PRIMARY KEY ("ownerId","workspaceId","botKey"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "botId" uuid, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz)`)
    await pool.query(await readFile(new URL('../drizzle/20261101020201_workspace_personal_policies.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../drizzle/20261101021000_model_api_keys.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    await pool.query(migration)
    const choiceMigration = await readFile(new URL('../drizzle/20261101021100_bot_api_key_choice.sql', import.meta.url), 'utf8')
    await pool.query(choiceMigration)
    await pool.query(choiceMigration)
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
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: wrongKey }, { env, fetch: fetchWith(() => new Response('{}', { status: 401 })) }), { code: 'apiKeyInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: downKey }, { env, fetch: fetchWith(() => new Response('', { status: 503 })) }), { code: 'apiKeyUnverifiable' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_keys')).rows[0].n, 0)
    assert.equal(calls[0].url, 'https://api.deepseek.com/models')
    assert.equal(calls[0].headers.authorization, `Bearer ${wrongKey}`)

    // A preset key: checked, listed, sealed, last four only.
    const secret = firstKey
    const anthropic = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: secret }, { env, fetch: fetchWith(() => models(['claude-opus-5-5', 'claude-sonnet-5-5'])) })
    assert.equal(calls.at(-1)!.headers['x-api-key'], secret)
    assert.deepEqual({ ...anthropic, id: undefined }, { id: undefined, provider: 'anthropic', name: null, baseUrl: null, protocol: 'anthropic', last4: firstKey.slice(-4), models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })
    const raw = (await pool.query('SELECT * FROM model_api_keys WHERE id=$1', [anthropic.id])).rows[0]
    assert.ok(!JSON.stringify(raw).includes(secret), 'stored sealed')
    // Adding the same preset again replaces the key in place.
    const replaced = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: newKey }, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })
    assert.equal(replaced.id, anthropic.id)
    assert.equal(replaced.last4, newKey.slice(-4))

    // Custom providers: https on a public address only; the person's own model list wins.
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'http://example.com/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://10.0.0.8/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://llm.internal.example/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])), resolve: async () => ['192.168.1.4'] }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', apiKey: customKey }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1', VERCEL: '1' }, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    const gateway = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Gateway', baseUrl: 'https://gateway.example.com/v1/', protocol: 'openai', apiKey: gatewayKey, models: ['qwen-max', 'qwen-max'] }, { env, fetch: fetchWith(() => models(['a', 'b'])), resolve: async () => ['93.184.216.34'] })
    assert.equal(calls.at(-1)!.url, 'https://gateway.example.com/v1/models')
    assert.deepEqual([gateway.baseUrl, gateway.protocol, gateway.models], ['https://gateway.example.com/v1', 'openai', ['qwen-max']])
    const local = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:8787', protocol: 'anthropic', apiKey: localKey }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1' }, fetch: fetchWith(() => models(['glm-5'])) })
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
    assert.ok(!JSON.stringify(bobPage).includes('test-'), 'views never carry the key')

    // The picker: own keys first when allowed here, then teammates' shared keys.
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.provider, key.mine]), [['anthropic', true], ['custom', false]])
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id)).map(key => key.name), [], 'Bob did not share his own credentials here, and nobody shared with him')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', personal.id)).map(key => key.provider), ['anthropic'])
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=false WHERE "workspaceId"=$1', [team.id])
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id), [], 'the admin switch turns off members\' credentials')
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [team.id])

    // A bot's saved model can be an API key's: usable here, reaching bot chats, a model the key lists.
    const scope = { ownerId: 'alice', workspaceId: team.id }
    const aliceBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId") VALUES ($1,$2,$3)', [aliceBot, team.id, 'alice'])
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, aliceBot, anthropic.id, 'not-listed'), { code: 'executionModelUnknown' })
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, randomUUID(), anthropic.id, 'claude-opus-5-5'), { code: 'botNotFound' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, aliceBot, gateway.id, 'qwen-max'), { keyId: gateway.id, model: 'qwen-max', harness: 'codex' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5'), { keyId: anthropic.id, model: 'claude-opus-5-5', harness: 'claude_code' })
    assert.deepEqual(await store.botApiKeyChoice(pool, scope, aliceBot), { keyId: gateway.id, model: 'qwen-max', harness: 'codex' })
    await assert.rejects(pool.query(`INSERT INTO bot_model_choices VALUES ('alice',$1,'both',$2,$3,'m')`, [team.id, randomUUID(), anthropic.id]), { code: '23514' }, 'a choice is a binding or a key, not both')
    // An Anthropic-only custom provider serves threads, not bot chats.
    await store.setApiKeyShare(pool, 'bob', team, local.id, true)
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, aliceBot, local.id, 'glm-5'), { code: 'executionModelUnknown' })
    await store.setApiKeyShare(pool, 'bob', team, local.id, false)
    // Each bot-chat model call opens the key again through the same rule.
    assert.deepEqual(await store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { apiKey: gatewayKey, baseUrl: 'https://gateway.example.com/v1', keyOwnerId: 'bob' })
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, anthropic.id, env)).baseUrl, 'https://api.anthropic.com/v1')
    await assert.rejects(store.openApiKeyForChat(pool, 'carol', team.id, anthropic.id, env), { code: 'apiKeyNotFound' })

    // Run injection: only an active run whose owner may use the key here.
    const teamBot = randomUUID(), personalBot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2),($3,$4)', [teamBot, team.id, personalBot, personal.id])
    const run = randomUUID(), done = randomUUID(), carolRun = randomUUID(), loose = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running'),($3,'alice',$2,'succeeded'),($4,'carol',$2,'queued'),($5,'bob',NULL,'running')`, [run, teamBot, done, carolRun, loose])
    const stopped = async (id: string) => Boolean((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [id])).rows[0].stopRequestedAt)
    const claude = await store.apiKeyForRun(pool, run, anthropic.id, env)
    assert.deepEqual(claude, { harness: 'claude_code', keyId: anthropic.id, ownerId: 'alice', env: { ANTHROPIC_API_KEY: newKey, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const codex = await store.apiKeyForRun(pool, run, gateway.id, env)
    assert.equal(codex.harness, 'codex')
    assert.deepEqual(codex.harness === 'codex' && [codex.env, codex.codex.model_providers.mikka], [{ MIKKA_MODEL_API_KEY: gatewayKey }, { name: 'Gateway', base_url: 'https://gateway.example.com/v1', env_key: 'MIKKA_MODEL_API_KEY', wire_api: 'chat' }])
    await assert.rejects(store.apiKeyForRun(pool, done, anthropic.id, env), { code: 'apiKeyNotFound' }, 'finished runs get nothing')
    await assert.rejects(store.apiKeyForRun(pool, carolRun, anthropic.id, env), { code: 'apiKeyNotFound' }, 'Alice did not share her key with the team')
    assert.equal((await store.apiKeyForRun(pool, carolRun, gateway.id, env)).ownerId, 'bob', 'Bob shared his with the team')
    assert.equal((await store.apiKeyForRun(pool, loose, local.id, env)).harness, 'claude_code', 'a run without a bot may use its owner\'s own key')
    await assert.rejects(store.apiKeyForRun(pool, loose, anthropic.id, env), { code: 'apiKeyNotFound' })
    // Withdrawing the share stops the run that was handed the key, and no later run gets it.
    assert.equal(await stopped(carolRun), false)
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, false)
    assert.equal(await stopped(carolRun), true)
    assert.equal(await stopped(run), true, 'Alice\'s run had Bob\'s key too')
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, env), { code: 'apiKeyNotFound' })
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
    // A copied ciphertext does not open on another row.
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, true)
    await pool.query('UPDATE model_api_keys SET ciphertext=(SELECT ciphertext FROM model_api_keys WHERE id=$1), iv=(SELECT iv FROM model_api_keys WHERE id=$1) WHERE id=$2', [local.id, gateway.id])
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, env), { code: 'apiKeyNotFound' })

    // A member leaving takes their shares; removing a key removes its shares.
    await store.removeMemberApiKeyShares(pool, 'bob', team.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)
    await store.setApiKeyShare(pool, 'bob', team, local.id, true)
    assert.equal(await stopped(run), true, 'leaving stops runs on the leaver\'s keys')
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
    assert.deepEqual(await store.removeApiKey(pool, 'alice', local.id), { removed: false }, 'only the owner removes a key')
    assert.deepEqual(await store.removeApiKey(pool, 'bob', local.id), { removed: true })
    // Deleting a key deletes the bot choices on it; those bots fall back to the usual order.
    await store.removeApiKey(pool, 'alice', anthropic.id)
    assert.equal(await store.botApiKeyChoice(pool, scope, null), undefined)
    assert.ok(await store.botApiKeyChoice(pool, scope, aliceBot), 'Bob\'s gateway choice stays')
    assert.equal(await stopped(loose), true, 'deleting a key stops the run that has it')
    assert.equal(await stopped(run), false, 'other keys\' runs go on')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)

    await store.setApiKeyAfterQuota(pool, 'alice', false)
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).apiKeyAfterQuota, false)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
