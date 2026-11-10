import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), 'Shared Bot acceptance requires isolated loopback *_e2e PostgreSQL')
if (!url && process.env.REQUIRE_DB === '1') throw Error('Shared Bot PostgreSQL acceptance cannot skip in required CI')

test('shared Bot replies bind a real Actor, exact organization connection, clean context and durable limits', { skip: !url, timeout: 240_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', ''), appName = `shared_bot_app_${suffix}_e2e`, wsName = `shared_bot_ws_${suffix}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  for (const name of [appName, wsName]) await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const appUrl = new URL(url!), wsUrl = new URL(url!); appUrl.pathname = `/${appName}`; wsUrl.pathname = `/${wsName}`
  const app = new Pool({ connectionString: appUrl.toString(), max: 6 }), ws = new Pool({ connectionString: wsUrl.toString(), max: 5 })
  const names = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'WORKSPACE_SECRETS_KEY', 'MIKKA_MODEL_KEY_LOOPBACK'] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { MIKKA_DATABASE_URL: appUrl.toString(), DATABASE_URL: wsUrl.toString(),
    WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), MIKKA_MODEL_KEY_LOOPBACK: '1' })
  // Only the credential registration probe reaches this isolated endpoint.
  // This suite never presents a fixture model response as provider execution.
  let outbound = 0
  const provider = createServer((request, response) => {
    outbound++
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[{"id":"shared-fixture-model"}]}') }
    else { response.writeHead(400); response.end('{}') }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address(); assert.ok(address && typeof address === 'object')
  let moduleApp: Pool | undefined, moduleWs: Pool | undefined
  let resetWake: (() => void) | undefined
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const database of [app, ws]) await database.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) {
      const source = await readFile(new URL(name, directory), 'utf8'), plan = planMigration(name, source)
      const client = await (plan.target === 'DATABASE_URL' ? ws : app).connect()
      try {
        const scope = scopeMigrationBeforeCommit(name, source)
        await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
        if (scope !== null) await client.query('COMMIT')
      } finally { client.release() }
    }
    moduleApp = (await import('../lib/db')).pool; moduleWs = (await import('../lib/workspace-db')).workspacePool
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const { enterprisePrincipal } = await import('../lib/enterprise/principal')
    const { changeResourceAccess, botChatResourceId } = await import('../lib/resource-access/store')
    const { submitBotChatMessage, botChatContributionPolicy, liveBotChatAuthority, reserveBotChatModelCall,
      sharedBotRuntime, recordBotChatResourceRead } = await import('../lib/collaboration/bot-chat')
    const { botChatMessageVisible, botChatEventVisible, botChatExecutionVisible, sharedBotInbox } = await import('../lib/collaboration/bot-chat-provenance')
    const { saveOrganizationConnection, configureOrganizationModels } = await import('../lib/organization-connections')
    const { DEFAULT_ORGANIZATION_MODEL_POLICY } = await import('../lib/organization-model-policy')
    const { setBotApiKeyChoice } = await import('../lib/model-api-keys')
    const { agentKitDefaults, agentKitStore } = await import('../lib/agent-kit/service')
    const { beginPreparedAgentExecution } = await import('../workflows/coordinator/agent-kit-steps')
    const store = await import('../lib/coordinator/store')
    const { coordinatorWakeTransport } = await import('../lib/coordinator/wake-after-commit')
    const previousWake = coordinatorWakeTransport.wake
    const wakes: string[] = []; coordinatorWakeTransport.wake = async owner => { wakes.push(owner) }
    resetWake = () => { coordinatorWakeTransport.wake = previousWake }

    const owner = `owner-${suffix}`, actor = `actor-${suffix}`, peer = `peer-${suffix}`, stranger = `stranger-${suffix}`
    const organization = randomUUID(), foreignOrg = randomUUID(), workspace = randomUUID(), foreignWorkspace = randomUUID()
    const sessions = new Map<string, string>()
    for (const id of [owner, actor, peer, stranger]) {
      await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@shared.invalid\',true,now(),now())', [id])
      const sessionId = randomUUID(); sessions.set(id, sessionId)
      await app.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), id])
    }
    for (const [org, tenant] of [[organization, workspace], [foreignOrg, foreignWorkspace]]) {
      await ws.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,\'Shared Bot fixture\',$2)', [org, owner])
      await ws.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Shared Bot fixture\',\'team\')', [tenant, owner])
      await ws.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [tenant, org])
      for (const id of [owner, actor, peer]) {
        await ws.query('INSERT INTO mikka_organization_members("organizationId","userId",name,email,role,status) VALUES($1,$2,$2,$2,$3,\'active\')', [org, id, id === owner ? 'owner' : 'member'])
        await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,$3,\'active\')', [tenant, id, id === owner ? 'admin' : 'member'])
      }
    }
    // Organization membership by itself never enters this Workspace.
    await ws.query('INSERT INTO mikka_organization_members("organizationId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'admin\',\'active\')', [organization, stranger])
    const reader = (id: string, tenant = workspace) => ({ id, [tokenWorkspace]: tenant,
      [enterprisePrincipal]: { kind: 'session' as const, sessionId: sessions.get(id)! } })
    const bot = randomUUID(), foreignBot = randomUUID(), oldMessage = randomUUID(), oldEvent = randomUUID()
    for (const [id, tenant] of [[bot, workspace], [foreignBot, foreignWorkspace]])
      await app.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Shared Bot\')', [id, owner, tenant])
    await app.query('INSERT INTO coordinator_sessions("userId","botId",memory,summary) VALUES($1,$2,\'owner-private-memory\',\'owner-private-summary\')', [owner, bot])
    const privateMessage = { role: 'assistant', content: 'owner-private-session-content' }
    await app.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,1,$4)', [oldMessage, owner, bot, privateMessage])
    const privateDefinition = { ...agentKitDefaults(), instructions: 'owner-private-system-instruction' }
    await agentKitStore.active({ ownerId: owner, botId: bot, workspaceId: workspace }, privateDefinition)
    const change = async (kind: 'chat' | 'task', id: string, visibility: 'private' | 'shared', grants: { subjectId: string; capabilities: ('canReadContent' | 'canComment' | 'canSteer')[] }[] = []) => {
      const { rows: [policy] } = await app.query('SELECT revision FROM resource_access_policies WHERE kind=$1 AND id=$2', [kind, id])
      return changeResourceAccess(reader(owner), { kind, id, workspaceId: workspace }, { visibility, grants, expectedRevision: policy.revision, confirmExpansion: true })
    }
    const message = (text: string, mode: 'comment' | 'reply' = 'reply', submissionId = randomUUID()) => ({ text, mode, submissionId })
    await assert.rejects(submitBotChatMessage(reader(actor), bot, message('Private must remain private')), { code: 'issueNotFound' })
    await change('chat', botChatResourceId(owner, bot), 'shared')
    await app.query('INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$3,\'user_message\',$1::text,\'{"text":"legacy private pending"}\')', [oldEvent, owner, bot])
    const oldSource = { role: 'user', content: 'legacy private pending', mikkaUserEvent: { id: oldEvent } }
    assert.equal(await botChatMessageVisible(app, { ownerId: owner, botId: bot, messageId: oldMessage, message: privateMessage }), false)
    assert.equal(await botChatMessageVisible(app, { ownerId: owner, botId: bot, message: oldSource }), false)

    await t.test('comments never reserve provider capacity; foreign actors and forged authority are rejected', async () => {
      const comment = await submitBotChatMessage(reader(actor), bot, message('Explicit shared comment', 'comment'))
      assert.equal(comment.queued, false)
      const authority = (await app.query('SELECT * FROM bot_chat_submission_authorities WHERE "eventId"=$1', [comment.eventId])).rows[0]
      assert.equal(authority.actorId, actor); assert.equal(authority.ownerId, owner); assert.equal(authority.modelSnapshot, null)
      assert.equal((await app.query('SELECT count(*) FROM bot_chat_model_calls')).rows[0].count, '0')
      assert.ok((await app.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [comment.eventId])).rows[0].deliveredAt)
      assert.equal(await botChatEventVisible(app, { ownerId: owner, botId: bot, eventId: comment.eventId }), true)
      await assert.rejects(submitBotChatMessage(reader(stranger), bot, message('An Org admin is not a Workspace member')))
      await assert.rejects(submitBotChatMessage(reader(actor, foreignWorkspace), bot, message('Wrong tenant')))
      await assert.rejects(submitBotChatMessage(reader(actor), foreignBot, message('Forged Bot id')))
      await assert.rejects(submitBotChatMessage(reader(actor), bot, { ...message('Forged owner'), ownerId: actor } as never))
      await assert.rejects(submitBotChatMessage(reader(actor), bot, message('No implicit model funding')), { code: 'executionModelUnknown' })
      assert.equal(outbound, 0)
      assert.deepEqual(wakes, [], 'comments cannot wake an owner-funded model turn')
    })

    const connection = await saveOrganizationConnection(organization, owner, { connectionKind: 'custom_endpoint', credential: {
      provider: 'custom', name: 'Isolated fixture endpoint', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: `synthetic-${randomUUID()}` } })
    const policy = { ...DEFAULT_ORGANIZATION_MODEL_POLICY, models: { 'shared-fixture-model': { mode: 'organization_only' as const, connectionId: connection.id } },
      sharedChat: { maxModelCallsPerTurn: 2, maxRepliesPerDay: 30, maxOutputTokens: 512 } }
    await configureOrganizationModels(organization, owner, policy)
    await setBotApiKeyChoice(app, { ownerId: owner, workspaceId: workspace }, bot, connection.id, 'shared-fixture-model')
    const probes = outbound
    const firstInput = message('Actor one funded reply'), secondInput = message('Actor two separate reply')
    const [first, replay] = await Promise.all([submitBotChatMessage(reader(actor), bot, firstInput), submitBotChatMessage(reader(actor), bot, firstInput)])
    assert.equal(first.eventId, replay.eventId); assert.equal(Number(first.duplicate) + Number(replay.duplicate), 1)
    const second = await submitBotChatMessage(reader(peer), bot, secondInput)
    const selected = await liveBotChatAuthority(app, first.eventId, { ownerId: owner, botId: bot })
    assert.ok(selected.modelSnapshot)
    assert.equal(selected.modelSnapshot.actorId, actor)
    assert.equal(selected.modelSnapshot.credentialOwnerId, `organization:${organization}`)
    assert.equal(selected.modelSnapshot.ownerId, owner)
    await assert.rejects(submitBotChatMessage(reader(peer), bot, firstInput), { message: 'submissionConflict' })
    await assert.rejects(app.query('UPDATE bot_chat_submission_authorities SET "actorId"=$2 WHERE "eventId"=$1', [first.eventId, peer]), { code: '23514' })

    await t.test('the real inbox never mixes Actors, and a kit-disabled shared reply still freezes a clean execution', async () => {
      const candidates = (await app.query('SELECT id,kind FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2 AND "deliveredAt" IS NULL ORDER BY "createdAt",id', [owner, bot])).rows
      const isolated = await sharedBotInbox(app, { ownerId: owner, botId: bot, candidates })
      assert.equal(isolated?.length, 1); assert.equal(isolated?.[0].id, first.eventId)
      assert.ok((await app.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [oldEvent])).rows[0].deliveredAt)
      const holder = `shared-bot:${randomUUID()}`
      await app.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=now()+interval \'5 minutes\' WHERE "userId"=$1 AND "botId"=$2', [owner, bot, holder])
      const inbox = await store.takeInbox(owner, holder, bot)
      assert.equal(inbox.sourceEventId, first.eventId); assert.equal(inbox.added, 1); assert.deepEqual(inbox.telegramTargets, [])
      assert.equal((await app.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [second.eventId])).rows[0].deliveredAt, null)
      const execution = await beginPreparedAgentExecution(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, first.eventId)
      assert.ok(execution)
      assert.equal(execution.snapshot.contextIsolation, 'shared_clean')
      assert.equal(execution.snapshot.definition.instructions, '')
      assert.deepEqual(execution.snapshot.definition.skills, [])
      assert.equal(execution.snapshot.personalPlugins, undefined)
      assert.equal(execution.snapshot.runtime.actorId, actor)
      assert.ok(!JSON.stringify(execution.snapshot).includes('owner-private-system-instruction'))
      const prompt = await store.loadSharedConversationForPrompt(owner, bot, first.eventId)
      assert.equal(prompt.memory, ''); assert.equal(prompt.summary, null)
      assert.ok(!JSON.stringify(prompt).includes('owner-private-session-content'))
      assert.ok(!JSON.stringify(prompt).includes('legacy private pending'))
      await store.appendMessages(owner, holder, [{ role: 'assistant', content: 'An explicitly shared answer.' }], null, bot, `${holder}:0`)
      const stored = (await app.query('SELECT id,message FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position DESC LIMIT 1', [owner, bot])).rows[0]
      assert.equal(await botChatMessageVisible(app, { ownerId: owner, botId: bot, messageId: stored.id, message: stored.message }), true)
      assert.equal(await botChatExecutionVisible(app, { ownerId: owner, botId: bot, executionKey: `${holder}:0` }), true)
      await assert.rejects(agentKitStore.beginExecution({ ownerId: owner, botId: bot, workspaceId: workspace }, `${holder}:forged`, 'Platform', execution.snapshot.runtime, privateDefinition), { code: '23514' })
    })

    await t.test('provider admission consumes bounded reservations without issuing a model request', async () => {
      const outcomes = await Promise.allSettled([1, 2, 3].map(step => reserveBotChatModelCall(selected.modelSnapshot!, { workflowRunId: 'fixture-workflow', stepId: `call-${step}` })))
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 2)
      const denial = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
      assert.equal(denial.reason.code, 'botChatModelCallBudgetExceeded')
      assert.equal((await app.query('SELECT count(*) FROM bot_chat_model_calls WHERE "eventId"=$1', [first.eventId])).rows[0].count, '2')
      await assert.rejects(app.query('INSERT INTO bot_chat_model_calls(id,"eventId") VALUES($1,$2)', [randomUUID(), first.eventId]), { code: '23514' })
      assert.equal(outbound, probes, 'capacity tests never fabricate or purchase a provider completion')
    })

    await t.test('current Session, Workspace membership, organization policy and key revision are required at every boundary', async () => {
      await app.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [sessions.get(peer)])
      await assert.rejects(liveBotChatAuthority(app, second.eventId, { ownerId: owner, botId: bot }), { code: 'authRequired' })
      await app.query('UPDATE session SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1', [sessions.get(peer)])
      await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, peer])
      await assert.rejects(liveBotChatAuthority(app, second.eventId, { ownerId: owner, botId: bot }))
      await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, peer])
      await configureOrganizationModels(organization, owner, { ...policy, sharedChat: { ...policy.sharedChat, maxOutputTokens: 1024 } })
      await assert.rejects(liveBotChatAuthority(app, second.eventId, { ownerId: owner, botId: bot }), { code: 'executionModelUnknown' })
      await assert.rejects(sharedBotRuntime(owner, bot), { code: 'authRequired' })
    })

    await t.test('source privacy revocation also hides answers derived from earlier shared answers', async () => {
      const task = randomUUID()
      await app.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'Shared source\',\'{"type":"doc","content":[{"type":"paragraph"}]}\',\'todo\',\'normal\')', [task, owner, workspace])
      await change('task', task, 'shared')
      const source = await submitBotChatMessage(reader(actor), bot, message('Read a public Task'))
      assert.equal(await recordBotChatResourceRead(owner, { eventId: source.eventId, botId: bot }, 'task', task), true)
      const holder = `source:${randomUUID()}`
      await app.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=now()+interval \'5 minutes\' WHERE "userId"=$1 AND "botId"=$2', [owner, bot, holder])
      await beginPreparedAgentExecution(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, source.eventId)
      await store.appendMessages(owner, holder, [{ role: 'assistant', content: 'Derived Task content.' }], null, bot, `${holder}:0`)
      const derived = await submitBotChatMessage(reader(peer), bot, message('Summarize the earlier answer'))
      await store.loadSharedConversationForPrompt(owner, bot, derived.eventId)
      assert.equal((await app.query('SELECT count(*) FROM bot_chat_resource_reads WHERE "eventId"=$1 AND "resourceId"=$2', [derived.eventId, task])).rows[0].count, '1')
      const holder2 = `derived:${randomUUID()}`
      await app.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=now()+interval \'5 minutes\' WHERE "userId"=$1 AND "botId"=$2', [owner, bot, holder2])
      await beginPreparedAgentExecution(owner, bot, holder2, 0, { harness: 'ai_sdk' }, false, derived.eventId)
      await store.appendMessages(owner, holder2, [{ role: 'assistant', content: 'A summary of Task content.' }], null, bot, `${holder2}:0`)
      await change('task', task, 'private')
      assert.equal(await botChatExecutionVisible(app, { ownerId: owner, botId: bot, executionKey: `${holder}:0` }), false)
      assert.equal(await botChatExecutionVisible(app, { ownerId: owner, botId: bot, executionKey: `${holder2}:0` }), false)
      await assert.rejects(liveBotChatAuthority(app, derived.eventId, { ownerId: owner, botId: bot }), { code: 'workspaceAccessDenied' })
    })

    await t.test('a daily limit prevents replies without hiding comments or exposing other members usage', async () => {
      await configureOrganizationModels(organization, owner, { ...policy, sharedChat: { ...policy.sharedChat, maxRepliesPerDay: 1 } })
      const safe = await botChatContributionPolicy(reader(actor), bot)
      assert.equal(safe.canReply, false); assert.equal(safe.reason, 'botChatDailyBudgetExceeded')
      assert.equal('usedReplies' in safe, false); assert.equal('remainingReplies' in safe, false)
      await assert.rejects(submitBotChatMessage(reader(actor), bot, message('Over the daily limit')), { code: 'botChatDailyBudgetExceeded' })
      assert.equal((await submitBotChatMessage(reader(actor), bot, message('A comment remains available', 'comment'))).queued, false)
    })
  } finally {
    resetWake?.()
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    await Promise.all([app.end(), ws.end(), moduleApp?.end(), moduleWs?.end()])
    for (const name of [appName, wsName]) await dropTestDatabase(admin, name)
    await admin.end()
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
  }
})
