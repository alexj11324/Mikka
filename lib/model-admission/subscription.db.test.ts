import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { streamText } from 'ai'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedTeam, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { SubscriptionRepository } from '../subscription-repository'
import { SubscriptionService } from '../subscription-service'
import { subscriptionNativeHTTP } from '../subscription-native-http'
import { freezeHostedModelSelection, resolveFrozenHostedModel } from '../subscription-model-snapshot'
import { modelAdmissionRevision, subscriptionModelRoute } from './contract'

// Real policy/membership/ledger PG, actual SDK parser and loopback HTTP. The
// private worker boundary is a fixture; this does not claim live SaaS or Go execution.
test('managed subscription routes authorize the existing service and native HTTP boundaries', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 6 })
  const { ModelAdmissionStore } = await import('./store')
  const store = new ModelAdmissionStore(pool)
  const ownerId = await seedUser(pool, 'subscription-admission')
  const owner = { ownerId }
  const one = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const two = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const revisions = new Map<string, string>()
  const rule = (route: string, model = 'fixture-model', dataRegions = ['unknown']) => ({
    ...subscriptionModelRoute(route), model, servingProviders: [route.startsWith('codex') ? 'openai' : 'anthropic'], principalIds: [ownerId], dataRegions,
  })
  const set = async (workspaceId: string, routes: unknown[], revoked = false) => {
    const result = await store.set({ ...owner, workspaceId }, revisions.get(workspaceId) ?? modelAdmissionRevision(null), { schemaVersion: 1, routes, revoked })
    revisions.set(workspaceId, result.revision)
  }
  await set(one.id, [rule('codex_cpa'), rule('claude_cpa')])
  await set(two.id, [])
  const repository = new SubscriptionRepository(pool)
  const connections: string[] = []
  const bind = async (workspaceId: string, consumerId: string, route: 'codex_cpa' | 'claude_cpa' | 'codex_cli') => {
    const provider = route.startsWith('codex') ? 'codex' : 'claude'
    const connectionId = randomUUID()
    connections.push(connectionId)
    const quota = { vendor: provider === 'codex' ? 'codex' : 'claude_code', status: 'ok', source: 'official', plan: 'fixture', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: 0.2, resetsAt: null }] }
    await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject",quota)
      VALUES($1,$2,$3,$4,'connected',$5,$6,'fixture-subject',$7)`, [connectionId, ownerId, workspaceId, provider, `fixture-never-read-${connectionId}`, 'f'.repeat(64), quota])
    return repository.bind(ownerId, workspaceId, consumerId, connectionId, 1, route, 'fixture-model')
  }
  let providerCalls = 0, workerCalls = 0
  let nativeHTTP: ReturnType<typeof subscriptionNativeHTTP>
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      if (incoming.url === '/provider') {
        providerCalls++
        const body = JSON.parse(raw.toString())
        assert.equal(body.model, 'fixture-model')
        assert.equal(body.stream, true)
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        outgoing.end(`data: ${JSON.stringify({ id: 'fixture-receipt', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'permitted' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture-receipt', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const [, , deviceId, runId] = incoming.url!.split('/')
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
      const response = await nativeHTTP(request, { params: Promise.resolve({ deviceId, runId }) })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body as never).pipe(outgoing)
      else outgoing.end()
    } catch { outgoing.writeHead(500).end('fixture_failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const worker = {
    forUse() { return this },
    async call() { workerCalls++; return { accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    stream(_revision: number, _model: string, payload: unknown, signal?: AbortSignal) {
      workerCalls++
      let reader: ReadableStreamDefaultReader<Uint8Array>
      return new ReadableStream<Uint8Array>({
        async start() { const response = await fetch(`${origin}/provider`, { method: 'POST', body: JSON.stringify(payload), signal }); reader = response.body!.getReader() },
        async pull(controller) { const part = await reader.read(); if (part.done) controller.close(); else controller.enqueue(part.value) },
        async cancel(reason) { await reader?.cancel(reason) },
      })
    },
    async nativeRequest(_revision: number, payload: { body: unknown }, signal?: AbortSignal) {
      workerCalls++
      const response = await fetch(`${origin}/provider`, { method: 'POST', body: JSON.stringify(payload.body), signal })
      return { contentType: 'text/event-stream', body: response.body! }
    },
  }
  const service = new SubscriptionService(repository, () => worker as never, { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined,
    async (ownerId, workspaceId) => { await store.read({ ownerId, workspaceId }) })
  nativeHTTP = subscriptionNativeHTTP({ authorize: async () => ownerId, service: () => service })
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await pool.query('DELETE FROM byos_native_runs WHERE "bindingId" IN (SELECT id FROM byos_bindings WHERE "connectionId"=ANY($1::uuid[]))', [connections])
    await pool.query('DELETE FROM byos_bindings WHERE "connectionId"=ANY($1::uuid[])', [connections])
    await pool.query('DELETE FROM byos_connections WHERE id=ANY($1::uuid[])', [connections])
    await pool.end(); await (await import('../db')).pool.end(); await (await import('../workspace-db')).workspacePool.end()
  })
  await t.test('same principal: allowed frozen BYOS models stream through the actual SDK; a second workspace refuses', async () => {
    for (const route of ['codex_cpa', 'claude_cpa'] as const) {
      const botId = await seedBot(pool, one.id, ownerId)
      const scope = { ownerId, botId, workspaceId: one.id }
      const bindingId = await bind(one.id, botId, route)
      const deps = { service: () => service, workspace: async (ownerId: string, workspaceId: string) => { await store.read({ ownerId, workspaceId }) } }
      const frozen = await freezeHostedModelSelection(scope, { harness: 'ai_sdk', model: null }, { type: 'subscription', bindingId }, deps)
      const model = await resolveFrozenHostedModel(scope, frozen, deps)
      const output = streamText({ model, prompt: 'isolated fixture', maxRetries: 0 })
      assert.equal(await output.text, 'permitted')
      const deniedBinding = await bind(two.id, botId, route)
      const before = workerCalls
      await assert.rejects(service.model({ ownerId, workspaceId: two.id, consumerId: botId, bindingId: deniedBinding, execution: 'model' }), /modelRouteDenied/)
      assert.equal(workerCalls, before)
    }
    assert.equal(providerCalls, 2)
  })
  await t.test('cached SDK calls recheck policy and cancellation without constructing a default paid fallback', async () => {
    const consumerId = randomUUID(), bindingId = await bind(one.id, consumerId, 'codex_cpa')
    const use = { ownerId, workspaceId: one.id, consumerId, bindingId, execution: 'model' as const }
    const model = await service.model(use)
    const before = providerCalls
    await set(one.id, [rule('codex_cpa'), rule('claude_cpa')], true)
    const result = streamText({ model, prompt: 'revoked fixture', maxRetries: 0, onError: () => {} })
    await assert.rejects(Promise.resolve(result.text))
    assert.equal(providerCalls, before)
    await set(one.id, [rule('codex_cpa', 'fixture-model', ['eu'])])
    await assert.rejects(service.model(use), /modelRegionUnverified/)
    await set(one.id, [rule('codex_cpa'), rule('claude_cpa')])
    const controller = new AbortController(); controller.abort()
    await assert.rejects(service.model(use, controller.signal), { name: 'AbortError' })
    assert.equal(providerCalls, before)
  })
  await t.test('native HTTP uses only a bound broker and intersects current Bot and task workspaces on every request', async () => {
    const botId = await seedBot(pool, one.id, ownerId)
    const team = await seedTeam(pool, two.id, ownerId)
    const issueId = randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,'Managed native fixture','{"type":"doc"}','doing','normal','workspace')`, [issueId, ownerId])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, team.id, two.id, ownerId])
    const deviceId = randomUUID(), agentId = randomUUID(), runId = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",name,harnesses) VALUES($1,$2,'managed native fixture',$3)`, [deviceId, ownerId, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true }])])
    await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'codex',$3,$4)`, [agentId, ownerId, `managed-${agentId}`, deviceId])
    const bindingId = await bind(one.id, agentId, 'codex_cli')
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","botId","issueId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,'running',now()+interval '2 minutes')`, [runId, ownerId, agentId, botId, issueId, deviceId])
    await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [runId, bindingId])
    const payload = { path: '/responses', headers: {}, body: { model: 'fixture-model', stream: true } }
    const post = (body: unknown) => fetch(`${origin}/native/${deviceId}/${runId}`, { method: 'POST', body: JSON.stringify(body) })
    const before = providerCalls
    assert.equal((await post({ action: 'request', payload })).status, 409)
    assert.equal(providerCalls, before)
    await set(two.id, [rule('codex_cli')])
    const context = await post({ action: 'context' })
    assert.equal(context.status, 200)
    const metadata = await context.json()
    assert.equal(metadata.route, 'codex_cli')
    assert.equal(Object.hasOwn(metadata, 'accessToken'), false)
    const allowed = await post({ action: 'request', payload })
    assert.equal(allowed.status, 200)
    assert.match(await allowed.text(), /permitted/)
    assert.equal(providerCalls, before + 1)
    let rawLauncherCalled = false
    await assert.rejects(service.launchNative(ownerId, agentId, bindingId, async () => { rawLauncherCalled = true }), /modelRouteDenied/)
    assert.equal(rawLauncherCalled, false)
    await set(two.id, [rule('codex_cli')], true)
    assert.equal((await post({ action: 'request', payload })).status, 409)
    assert.equal(providerCalls, before + 1)
    await set(two.id, [rule('codex_cli')])
    for (const changed of [{ ...payload, path: 'https://proxy.invalid/responses' }, { ...payload, body: { model: 'denied-model', stream: true } }])
      assert.equal((await post({ action: 'request', payload: changed })).status, 409)
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [two.id, ownerId])
    assert.equal((await post({ action: 'request', payload })).status, 409)
    assert.equal(providerCalls, before + 1)
    await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [two.id, ownerId])
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1`, [runId])
    assert.equal((await post({ action: 'request', payload })).status, 409)
    assert.equal(providerCalls, before + 1)
  })
  await t.test('audit names the actual fixed subscription transport without credentials, prompt text or invented geography', async () => {
    const { rows } = await pool.query(`SELECT action,metadata FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[]) AND action IN ('model.admitted','model.denied')`, [[one.id, two.id]])
    assert.ok(rows.some(row => row.action === 'model.admitted' && row.metadata.provider === 'openai-subscription'))
    assert.ok(rows.some(row => row.action === 'model.admitted' && row.metadata.provider === 'anthropic-subscription'))
    assert.ok(rows.some(row => row.action === 'model.denied' && row.metadata.reason === 'modelPolicyRevoked'))
    assert.ok(rows.every(row => !Object.hasOwn(row.metadata, 'prompt') && !Object.hasOwn(row.metadata, 'accessToken')))
    assert.ok(rows.filter(row => row.action === 'model.admitted').every(row => row.metadata.dataRegion === 'unknown'))
  })
})
