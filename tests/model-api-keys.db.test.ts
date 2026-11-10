import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { freezeWorkerDefinition } from '../lib/agent-kit/worker'

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
  const { workspacePool } = await import('../lib/workspace-db')
  const previousWorkspace = { connectionString: workspacePool.options.connectionString, options: workspacePool.options.options }
  Object.assign(workspacePool.options, { connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      INSERT INTO "user" VALUES ('alice'),('bob'),('carol');
      CREATE TABLE byos_connections (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, "removedAt" timestamptz, "modelCatalog" jsonb);
      CREATE TABLE byos_bindings ("connectionId" uuid, "modelId" text);
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "ownerId" text);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text NOT NULL CHECK (kind IN ('personal','team')));
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text);
      CREATE TABLE bot_model_choices ("ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, "botKey" text NOT NULL, "bindingId" uuid, PRIMARY KEY ("ownerId","workspaceId","botKey"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "botId" uuid, "deviceId" uuid, "agentDefinition" jsonb, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz)`)
    await pool.query(await readFile(new URL('../drizzle/20261101020201_workspace_personal_policies.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261109035020_organization_governance.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../drizzle/20261101021000_model_api_keys.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    await pool.query(migration)
    const choiceMigration = await readFile(new URL('../drizzle/20261101021100_bot_api_key_choice.sql', import.meta.url), 'utf8')
    await pool.query(choiceMigration)
    await pool.query(choiceMigration)
    const errorMigration = await readFile(new URL('../drizzle/20261102120000_model_api_key_models_error.sql', import.meta.url), 'utf8')
    await pool.query(errorMigration)
    await pool.query(errorMigration)
    const responsesMigration = await readFile(new URL('../drizzle/20261102190000_model_api_key_responses_api.sql', import.meta.url), 'utf8')
    await pool.query(responsesMigration)
    await pool.query(responsesMigration)
    const enabledMigration = await readFile(new URL('../drizzle/20261108120101_enabled_models.sql', import.meta.url), 'utf8')
    await pool.query(enabledMigration)
    await pool.query(enabledMigration)
    await pool.query(`CREATE TABLE workspace_audit_events (id uuid PRIMARY KEY,"workspaceId" uuid,"actorType" text,"actorName" text,action text,category text,"targetType" text,"targetId" text,metadata jsonb);
      CREATE TABLE byos_native_runs ("runId" uuid,"bindingId" uuid)`);
    await pool.query(`ALTER TABLE byos_bindings ADD COLUMN id uuid, ADD COLUMN "ownerId" text`);
    const legacyWorkspace = randomUUID(), legacyBinding = randomUUID(), legacyRun = randomUUID();
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ('alice',$1,true)`, [legacyWorkspace]);
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId") VALUES ($1,'alice')`, [legacyBinding]);
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentDefinition",status,"leaseExpiresAt") VALUES ($1,'bob',$2,'running',now()+interval '1 hour')`,
      [legacyRun, JSON.stringify({ subscription: { bindingId: legacyBinding } })]);
    for (const migration of ["20261110020020_personal_subscriptions_organization_connections.sql", "20261110020021_organization_model_policy.sql"]) {
      const sql = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
      await pool.query(sql);
      await pool.query(sql);
    }
    const preserved = (await pool.query(`SELECT "allowOthers","legacyAllowOthers","sharingRevokedAt" FROM workspace_subscription_shares WHERE "workspaceId"=$1`, [legacyWorkspace])).rows[0];
    assert.equal(preserved.allowOthers, false);
    assert.equal(preserved.legacyAllowOthers, true);
    assert.ok(preserved.sharingRevokedAt);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='credential.revoked'`, [legacyWorkspace])).rows[0].n, 1, 'replay cannot duplicate revocation audit');
    const stoppedLegacy = (await pool.query(`SELECT "stopRequestedAt" IS NOT NULL AND "leaseExpiresAt"<=now() AS stopped FROM agent_runs WHERE id=$1`, [legacyRun])).rows[0];
    assert.equal(stoppedLegacy.stopped, true, 'an old borrowed Run is stopped before any credential can be renewed');
    const legacyConsent = (await pool.query(`SELECT "legacyApiKeyAfterQuota","apiKeyFallbackAuthorizedAt" FROM "user" WHERE id='alice'`)).rows[0];
    assert.equal(legacyConsent.legacyApiKeyAfterQuota, true);
    assert.equal(legacyConsent.apiKeyFallbackAuthorizedAt, null);
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [legacyRun]);
    await pool.query('DELETE FROM byos_bindings WHERE id=$1', [legacyBinding]);
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "workspaceId"=$1', [legacyWorkspace]);
    assert.equal(await store.apiKeyAfterQuota(pool, 'alice'), false, 'paid fallback requires explicit fresh authorization')
    await store.setApiKeyAfterQuota(pool, 'alice', true)
    assert.equal(await store.apiKeyAfterQuota(pool, 'alice'), true)

    const personal = { id: randomUUID(), kind: 'personal' as const }
    const team = { id: randomUUID(), kind: 'team' as const }
    await pool.query('INSERT INTO mikka_workspaces(id,kind) VALUES ($1,$2),($3,$4)', [personal.id, personal.kind, team.id, team.kind])
    await pool.query('INSERT INTO mikka_workspace_members VALUES ($1,\'alice\',\'active\'),($1,\'bob\',\'active\'),($1,\'carol\',\'active\')', [team.id])
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
    assert.deepEqual({ ...anthropic, id: undefined }, { id: undefined, provider: 'anthropic', name: null, baseUrl: null, protocol: 'anthropic', last4: firstKey.slice(-4), models: ['claude-opus-5-5', 'claude-sonnet-5-5'], modelsError: null, responsesApi: true })
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
    // A custom OpenAI-protocol provider is also asked whether it has the Responses API; an answer that is not a refusal changes nothing.
    assert.deepEqual(calls.slice(-2).map(call => call.url), ['https://gateway.example.com/v1/models', 'https://gateway.example.com/v1/responses'])
    assert.equal(gateway.responsesApi, true)
    assert.deepEqual([gateway.baseUrl, gateway.protocol, gateway.models], ['https://gateway.example.com/v1', 'openai', ['qwen-max']])
    const local = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:8787', protocol: 'anthropic', apiKey: localKey }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1' }, fetch: fetchWith(() => models(['glm-5'])) })
    assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:8787/v1/models')

    // 重新获取模型 (decision 2026-11-02-1200): the stored key asks the provider again; its answer is the list.
    const refetched = await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5', 'claude-haiku-5-5'])) })
    assert.deepEqual([calls.at(-1)!.url, calls.at(-1)!.headers['x-api-key']], ['https://api.anthropic.com/v1/models?limit=1000', newKey])
    assert.deepEqual([refetched.models, refetched.modelsError], [['claude-opus-5-5', 'claude-haiku-5-5'], null])
    // A failed answer keeps the last list and says why, for the key's row; a good one clears the reason.
    const refused = await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => new Response('{}', { status: 401 })) })
    assert.deepEqual([refused.models, refused.modelsError], [['claude-opus-5-5', 'claude-haiku-5-5'], 'invalid'])
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => new Response('', { status: 503 })) })).modelsError, 'unavailable')
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).keys[0].modelsError, 'unavailable', 'the page reads the reason')
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })).modelsError, null)
    // Only the owner asks; a custom provider that lists nothing keeps the models it was added with.
    await assert.rejects(store.refreshApiKeyModels(pool, 'bob', anthropic.id, { env, fetch: fetchWith(() => models(['x'])) }), { code: 'apiKeyNotFound' })
    assert.deepEqual((await store.refreshApiKeyModels(pool, 'bob', gateway.id, { env, fetch: fetchWith(() => models([])), resolve: async () => ['93.184.216.34'] })).models, ['qwen-max'])
    // DNS rebinding: the custom provider's name now points inside; the refetch asks nothing and keeps the list.
    let asked = false
    const rebound = await store.refreshApiKeyModels(pool, 'bob', gateway.id, { env, fetch: fetchWith(() => { asked = true; return models(['x']) }), resolve: async () => ['10.0.0.8'] })
    assert.equal(asked, false, 'a provider whose host resolves to a private address is not asked')
    assert.deepEqual([rebound.models, rebound.modelsError], [['qwen-max'], 'unavailable'])
    assert.deepEqual((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models([])) })).models, [], 'a preset that lists nothing has nothing')
    await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })

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

    // The picker: own keys first, always (decision 2026-11-01-2240), then teammates' shared keys.
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.provider, key.mine]), [['anthropic', true], ['custom', false]])
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id)).map(key => [key.name, key.mine]), [['Gateway', true], ['Local', true]], 'Bob\'s own keys are his here without sharing; nobody shared with him')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', personal.id)).map(key => key.provider), ['anthropic'])
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=false WHERE "workspaceId"=$1', [team.id])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.provider, key.mine]), [['anthropic', true]], 'the admin switch turns off teammates\' shared keys, never her own')
    const anotherWorkspace = { id: randomUUID(), kind: 'team' as const }
    await pool.query('INSERT INTO mikka_workspaces(id,kind) VALUES ($1,$2)', [anotherWorkspace.id, anotherWorkspace.kind])
    await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [anotherWorkspace.id])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', anotherWorkspace.id)).map(key => [key.id, key.mine]), [[anthropic.id, true]], 'an own key works in another workspace with no share rows and sharing disabled')
    assert.equal((await store.listApiKeys(pool, 'alice', anotherWorkspace)).keys.some(key => key.id === anthropic.id), true, 'the account key is still manageable in the other workspace')
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [team.id])

    // The real catalogue trigger marks a newly reported model disabled. Keep
    // it in both catalogues so dropping modelSettings cannot pass by omission.
    const disabledModel = 'fixture-disabled-api-key-model'
    await pool.query('UPDATE model_api_keys SET models=models || $2::jsonb WHERE id=ANY($1::uuid[])', [[anthropic.id, gateway.id], JSON.stringify([disabledModel])])
    const catalogues = (await pool.query('SELECT id,models,"modelSettings" FROM model_api_keys WHERE id=ANY($1::uuid[])', [[anthropic.id, gateway.id]])).rows
    assert.equal(catalogues.length, 2)
    for (const key of catalogues) {
      assert.ok(key.models.includes(disabledModel))
      assert.deepEqual(key.modelSettings.models[disabledModel], { enabled: false, fresh: true, manual: false })
    }
    const governedScope = { ownerId: 'alice', workspaceId: team.id }

    // Empty borrowed-candidate reads can skip sharing policy; a real borrowed
    // candidate must still observe the current Organization rule and decision.
    const organization = randomUUID(), approval = randomUUID()
    await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES ($1,\'Fixture organization\',\'bob\')', [organization])
    await pool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES ($1,$2)', [team.id, organization])
    await pool.query('INSERT INTO mikka_organization_resource_policies("organizationId","modelCredentialSharing") VALUES ($1,\'deny\')', [organization])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.id, key.mine]), [[anthropic.id, true]], 'Organization deny removes only borrowed keys')
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id, gateway.id)).map(key => [key.id, key.mine]), [[gateway.id, true]], 'the owner keeps the exact selected own key')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, anthropic.id)).map(key => [key.mine, key.models]), [[true, ['claude-opus-5-5']]], 'own-key policy remains independent of Organization sharing, while disabled models stay hidden')
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id, gateway.id)).map(key => key.models), [['qwen-max']], 'the shared key owner gets the same enabled-model filter')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', personal.id, anthropic.id)).map(key => [key.id, key.mine, key.models]), [[anthropic.id, true, ['claude-opus-5-5']]], 'Personal owns the key but cannot re-enable a disabled catalogue model')
    await assert.rejects(store.setBotApiKeyChoice(pool, governedScope, null, anthropic.id, disabledModel), { code: 'executionModelUnknown' })
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { code: 'apiKeyNotFound' }, 'Organization deny also closes the actual borrowed-key open')
    await pool.query('UPDATE mikka_organization_resource_policies SET "modelCredentialSharing"=\'approval_required\' WHERE "organizationId"=$1', [organization])
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id, gateway.id), [], 'an exact selected borrowed key still needs approval')
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { code: 'apiKeyNotFound' }, 'unapproved sharing cannot open the borrowed credential')
    await pool.query('INSERT INTO mikka_organization_resource_approvals(id,"organizationId","workspaceId",kind,"resourceId","ownerId",status) VALUES ($1,$2,$3,\'api_key\',$4,\'bob\',\'approved\')', [approval, organization, team.id, gateway.id])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, gateway.id)).map(key => [key.id, key.mine]), [[gateway.id, false]], 'approval never widens selectedKeyId')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, gateway.id)).map(key => key.models), [['qwen-max']], 'approval authorizes the key, not its disabled catalogue models')
    await assert.rejects(store.setBotApiKeyChoice(pool, governedScope, null, gateway.id, disabledModel), { code: 'executionModelUnknown' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, governedScope, null, gateway.id, 'qwen-max'), { keyId: gateway.id, model: 'qwen-max', harnesses: ['codex'] })
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env)).keyOwnerId, 'bob')
    await pool.query('UPDATE mikka_organization_resource_approvals SET status=\'denied\' WHERE id=$1', [approval])
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id, gateway.id), [], 'the same caller observes approval revocation immediately')
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { code: 'apiKeyNotFound' }, 'a previously opened borrowed key cannot reopen after approval revocation')
    await pool.query('UPDATE mikka_organization_resource_policies SET "modelCredentialSharing"=\'allow\' WHERE "organizationId"=$1', [organization])
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id, gateway.id), [], 'an explicit denial still wins over allow')
    await pool.query('DELETE FROM mikka_organization_resource_approvals WHERE id=$1', [approval])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, gateway.id)).map(key => [key.id, key.mine]), [[gateway.id, false]], 'a subsequent read observes restored permission')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, gateway.id)).map(key => key.models), [['qwen-max']], 'allow still preserves the modelSettings restriction')
    await assert.rejects(store.setBotApiKeyChoice(pool, governedScope, null, gateway.id, disabledModel), { code: 'executionModelUnknown' })
    await pool.query('DELETE FROM mikka_organizations WHERE id=$1', [organization])

    // A bot's saved model can be an API key's: usable here, reaching bot chats, a model the key lists.
    const scope = { ownerId: 'alice', workspaceId: team.id }
    const aliceBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId") VALUES ($1,$2,$3)', [aliceBot, team.id, 'alice'])
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, aliceBot, anthropic.id, 'not-listed'), { code: 'executionModelUnknown' })
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, randomUUID(), anthropic.id, 'claude-opus-5-5'), { code: 'botNotFound' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, aliceBot, gateway.id, 'qwen-max'), { keyId: gateway.id, model: 'qwen-max', harnesses: ['codex'] })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5'), { keyId: anthropic.id, model: 'claude-opus-5-5', harnesses: ['claude_code'] })
    assert.deepEqual(await store.botApiKeyChoice(pool, scope, aliceBot), { keyId: gateway.id, model: 'qwen-max', harnesses: ['codex'] })
    await assert.rejects(pool.query(`INSERT INTO bot_model_choices VALUES ('alice',$1,'both',$2,$3,'m')`, [team.id, randomUUID(), anthropic.id]), { code: '23514' }, 'a choice is a binding or a key, not both')
    // An Anthropic-only custom provider serves threads, not bot chats.
    await store.setApiKeyShare(pool, 'bob', team, local.id, true)
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, aliceBot, local.id, 'glm-5'), { code: 'executionModelUnknown' })
    await store.setApiKeyShare(pool, 'bob', team, local.id, false)
    // Each bot-chat model call opens the key again through the same rule.
    assert.deepEqual(await store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { apiKey: gatewayKey, baseUrl: 'https://gateway.example.com/v1', keyOwnerId: 'bob' })
    for (const member of ['alice', 'bob']) {
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [team.id, member])
      await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { code: 'apiKeyNotFound' }, 'withdrawn requester or key-owner membership closes the shared chat key')
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [team.id, member])
    }
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, anthropic.id, env)).baseUrl, 'https://api.anthropic.com/v1')
    assert.equal((await store.openApiKeyForChat(pool, 'alice', anotherWorkspace.id, anthropic.id, env)).keyOwnerId, 'alice', 'Bot chat uses its own key across workspaces without team sharing')
    await assert.rejects(store.openApiKeyForChat(pool, 'carol', team.id, anthropic.id, env), { code: 'apiKeyNotFound' })

    // Run injection: only an active run whose owner may use the key here.
    const teamBot = randomUUID(), personalBot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2),($3,$4)', [teamBot, team.id, personalBot, personal.id])
    const run = randomUUID(), done = randomUUID(), carolRun = randomUUID(), loose = randomUUID(), sharedRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running'),($3,'alice',$2,'succeeded'),($4,'carol',$2,'queued'),($5,'bob',NULL,'running'),($6,'alice',$2,'running')`, [run, teamBot, done, carolRun, loose, sharedRun])
    const sharedDefinition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Gateway task', parent: null, executionId: null, model: 'qwen-max', apiKey: { keyId: gateway.id, model: 'qwen-max' } })
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$1 WHERE id=ANY($2::uuid[])', [JSON.stringify(sharedDefinition), [sharedRun, carolRun]])
    const stopped = async (id: string) => Boolean((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [id])).rows[0].stopRequestedAt)
    const claude = await store.apiKeyForRun(pool, run, anthropic.id, 'claude_code', env)
    assert.deepEqual(claude, { harness: 'claude_code', keyId: anthropic.id, ownerId: 'alice', env: { ANTHROPIC_API_KEY: newKey, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const otherBot = randomUUID(), otherRun = randomUUID()
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId") VALUES ($1,$2,$3)', [otherBot, anotherWorkspace.id, 'alice'])
    await pool.query('INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,$2,$3,\'running\')', [otherRun, 'alice', otherBot])
    assert.equal((await store.apiKeyForRun(pool, otherRun, anthropic.id, 'claude_code', env)).ownerId, 'alice', 'an Agent uses its own key across workspaces even with sharing disabled')
    await assert.rejects(store.apiKeyForRun(pool, run, gateway.id, 'codex', env), { code: 'apiKeyNotFound' }, 'an unbound historical run cannot newly borrow another member\'s key')
    const codex = await store.apiKeyForRun(pool, sharedRun, gateway.id, 'codex', env)
    assert.equal(codex.harness, 'codex')
    assert.deepEqual(codex.harness === 'codex' && [codex.env, codex.codex.model_providers.mikka], [{ MIKKA_MODEL_API_KEY: gatewayKey }, { name: 'Gateway', base_url: 'https://gateway.example.com/v1', env_key: 'MIKKA_MODEL_API_KEY', wire_api: 'responses' }])
    await assert.rejects(store.apiKeyForRun(pool, done, anthropic.id, 'claude_code', env), { code: 'apiKeyNotFound' }, 'finished runs get nothing')
    await assert.rejects(store.apiKeyForRun(pool, carolRun, anthropic.id, 'claude_code', env), { code: 'apiKeyNotFound' }, 'Alice did not share her key with the team')
    assert.equal((await store.apiKeyForRun(pool, carolRun, gateway.id, 'codex', env)).ownerId, 'bob', 'Bob shared his with the team')
    assert.equal((await store.apiKeyForRun(pool, loose, local.id, 'claude_code', env)).harness, 'claude_code', 'a run without a bot may use its owner\'s own key')
    await assert.rejects(store.apiKeyForRun(pool, loose, anthropic.id, 'claude_code', env), { code: 'apiKeyNotFound' })
    // A key that does not serve the run's Agent opens nothing: an Anthropic key for a Codex run, an OpenAI-protocol gateway for Claude Code.
    await assert.rejects(store.apiKeyForRun(pool, run, anthropic.id, 'codex', env), { code: 'apiKeyNotFound' })
    await assert.rejects(store.apiKeyForRun(pool, sharedRun, gateway.id, 'claude_code', env), { code: 'apiKeyNotFound' })
    // DeepSeek speaks both protocols (decision 2026-11-02-1600): one key, each Agent on its own endpoint.
    const deepseekKey = `sk-${randomUUID()}`
    const deepseek = await store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: deepseekKey }, { env, fetch: fetchWith(() => models(['deepseek-flash'])) })
    // Its own run, so the runs above keep the keys they were handed.
    const deepRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running')`, [deepRun, teamBot])
    const viaClaude = await store.apiKeyForRun(pool, deepRun, deepseek.id, 'claude_code', env)
    assert.deepEqual(viaClaude.env, { ANTHROPIC_API_KEY: deepseekKey, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' })
    const viaCodex = await store.apiKeyForRun(pool, deepRun, deepseek.id, 'codex', env)
    assert.deepEqual(viaCodex.harness === 'codex' && [viaCodex.env, viaCodex.codex.model_providers.mikka.base_url], [{ MIKKA_MODEL_API_KEY: deepseekKey }, 'https://api.deepseek.com/v1'])
    assert.deepEqual((await store.setBotApiKeyChoice(pool, scope, null, deepseek.id, 'deepseek-flash')).harnesses, ['claude_code', 'codex'])
    await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5')
    await store.removeApiKey(pool, 'alice', deepseek.id)
    assert.equal(await stopped(deepRun), true, 'removing the key stops the run that was handed it')
    // Withdrawing the share stops the run that was handed the key, and no later run gets it.
    assert.equal(await stopped(carolRun), false)
    await pool.query(`UPDATE agent_runs SET status='paused' WHERE id=$1`, [sharedRun])
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, false)
    assert.equal(await stopped(carolRun), true)
    assert.equal(await stopped(sharedRun), true, 'the paused Gateway run cannot resume with Bob\'s withdrawn key')
    assert.equal(await stopped(run), false, 'her own Anthropic run keeps its original key')
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, 'codex', env), { code: 'apiKeyNotFound' })
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
    // A copied ciphertext does not open on another row.
    await store.setApiKeyShare(pool, 'bob', team, gateway.id, true)
    await pool.query('UPDATE model_api_keys SET ciphertext=(SELECT ciphertext FROM model_api_keys WHERE id=$1), iv=(SELECT iv FROM model_api_keys WHERE id=$1) WHERE id=$2', [local.id, gateway.id])
    await assert.rejects(store.apiKeyForRun(pool, carolRun, gateway.id, 'codex', env), { code: 'apiKeyNotFound' })

    // A chat-only gateway (no Responses API, which Codex runs on): the key is saved, serves bot chats, and no Agent run.
    const chatKey = `sk-${randomUUID()}`
    let responses = 404
    const probes: { method?: string; body?: unknown; auth?: string }[] = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/responses')) {
        probes.push({ method: init?.method, body: init?.body, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
        return new Response('{"error":{"message":"bad request"}}', { status: responses })
      }
      return models(['chat-1'])
    }) as typeof fetch
    const chatOnly = await store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Chat only', baseUrl: 'https://chat.example.com/v1', protocol: 'openai', apiKey: chatKey }, { env, fetch: chatFetch, resolve: async () => ['93.184.216.34'] })
    assert.deepEqual(probes, [{ method: 'POST', body: '{}', auth: `Bearer ${chatKey}` }], 'one empty POST: no model is asked, so nothing is billed')
    assert.deepEqual([chatOnly.responsesApi, chatOnly.models], [false, ['chat-1']])
    assert.deepEqual((await store.setBotApiKeyChoice(pool, scope, null, chatOnly.id, 'chat-1')).harnesses, [], 'a bot chats on it; no thread runs on it')
    assert.deepEqual((await store.openApiKeyForChat(pool, 'alice', team.id, chatOnly.id, env)).baseUrl, 'https://chat.example.com/v1')
    // Its own run, so the runs above keep the keys they were handed.
    const chatRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running')`, [chatRun, teamBot])
    await assert.rejects(store.apiKeyForRun(pool, chatRun, chatOnly.id, 'codex', env), { code: 'apiKeyNotFound' })
    // 重新获取模型 asks again: a provider that says nothing keeps what was known; one that refuses the empty body has it now.
    responses = 503
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', chatOnly.id, { env, fetch: chatFetch, resolve: async () => ['93.184.216.34'] })).responsesApi, false)
    responses = 400
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', chatOnly.id, { env, fetch: chatFetch, resolve: async () => ['93.184.216.34'] })).responsesApi, true)
    assert.equal((await store.apiKeyForRun(pool, chatRun, chatOnly.id, 'codex', env)).harness, 'codex')
    await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5')
    await store.removeApiKey(pool, 'alice', chatOnly.id)

    // A member leaving takes their shares; removing a key removes its shares.
    await store.removeMemberApiKeyShares(pool, 'bob', team.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)
    await store.setApiKeyShare(pool, 'bob', team, local.id, true)
    assert.equal(await stopped(sharedRun), true, 'leaving stops runs on the leaver\'s keys')
    assert.equal(await stopped(run), false, 'leaving does not stop the requester\'s separate own-key run')
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
    assert.deepEqual(await store.removeApiKey(pool, 'alice', local.id), { removed: false }, 'only the owner removes a key')
    assert.deepEqual(await store.removeApiKey(pool, 'bob', local.id), { removed: true })
    // Removing a key preserves the old choice as unavailable, preventing an implicit payer change.
    await store.removeApiKey(pool, 'alice', anthropic.id)
    assert.equal((await store.botApiKeyChoice(pool, scope, null))?.keyId, anthropic.id)
    const removedKey = (await pool.query('SELECT ciphertext,iv,"revokedAt" FROM model_api_keys WHERE id=$1', [anthropic.id])).rows[0]
    assert.deepEqual([removedKey.ciphertext, removedKey.iv], ['', ''])
    assert.ok(removedKey.revokedAt)
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).keys.some(item => item.id === anthropic.id), false)
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, anthropic.id, env), { code: 'apiKeyNotFound' })
    assert.ok(await store.botApiKeyChoice(pool, scope, aliceBot), 'Bob\'s gateway choice stays')
    assert.equal(await stopped(loose), true, 'deleting a key stops the run that has it')
    assert.equal(await stopped(run), true, 'removing her own Anthropic key stops its own run')
    assert.equal(await stopped(sharedRun), false, 'other keys\' runs go on')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)

    await store.setApiKeyAfterQuota(pool, 'alice', false)
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).apiKeyAfterQuota, false)
  } finally {
    Object.assign(workspacePool.options, previousWorkspace)
    await workspacePool.end()
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
