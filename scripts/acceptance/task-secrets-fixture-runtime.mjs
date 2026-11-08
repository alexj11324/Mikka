// Disposable #1712 HTTPS fixture only. This is bundled into a fresh official
// E2B VM; it is never installed as an application route or reusable template.
import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { issueEgressCapability } from '../../lib/secrets/egress-capability.ts'
import { executeEgressRequest } from '../../lib/secrets/egress-http.ts'
import { taskSecretEgressResponse } from '../../lib/secrets/egress-route.ts'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const digest = value => createHash('sha256').update(value).digest('hex')
const tokenEquals = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))

async function body(request) {
  const parts = []; let bytes = 0
  for await (const part of request) {
    bytes += part.length
    if (bytes > 1024 * 1024) throw Error('fixture_request_limit')
    parts.push(part)
  }
  return Buffer.concat(parts)
}

/** No existing production credential enters this process. A production-store
 * case receives only the runner's newly-created synthetic canary through the
 * authenticated control route and never receives a fixture-issued grant. */
export async function startFixture(config, clientSource, { listenHost = '0.0.0.0', upstreamPort = 8080, egressPort = 8081 } = {}) {
  if (!UUID.test(config.fixtureId ?? '') || !/^[a-f0-9]{64}$/.test(config.controlToken ?? '')
    || !/^https:\/\/[a-zA-Z0-9.-]+$/.test(config.upstreamOrigin ?? '')
    || !/^https:\/\/[a-zA-Z0-9.-]+$/.test(config.egressOrigin ?? '')) throw Error('fixture_configuration')
  const cases = new Map()
  const reply = (response, status, value, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    response.end(JSON.stringify(value))
  }
  const notifyProtected = state => {
    if (state.runId && state.counts.protected > 0) for (const wake of state.protectedWaiters) wake()
  }
  const upstream = createServer((request, response) => {
    void handleUpstream(request, response).catch(() => reply(response, 400, { error: 'fixture_refused' }))
  })
  async function handleUpstream(request, response) {
    const sdkMatch = /^\/sdk\/([a-f0-9-]{36})\/v1\/chat\/completions$/.exec(request.url ?? '')
    if (sdkMatch) {
      const state = cases.get(sdkMatch[1])
      if (!state || state.mode !== 'production_claim' || state.expiresAt <= Date.now() || request.method !== 'POST')
        return reply(response, 404, { error: 'unavailable' })
      if (!tokenEquals(request.headers.authorization, `Bearer ${state.canary}`)) return reply(response, 401, { error: 'unauthorized' })
      const value = JSON.parse(await body(request))
      if (value.model !== 'synthetic-third-party-model' || value.stream === true || value.messages?.length !== 1
        || value.messages[0].role !== 'user' || value.messages[0].content !== 'Exercise production Secret delivery against the synthetic fixture.')
        return reply(response, 400, { error: 'fixture_scope' })
      state.counts.sdk++
      return reply(response, 200, { id: `chatcmpl-${state.caseId}`, object: 'chat.completion', created: 1,
        model: 'synthetic-third-party-model', choices: [{ index: 0, message: { role: 'assistant', content: state.sdkResponse }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
    }
    const match = /^\/v1\/(public|protected|echo|redirect)\/([a-f0-9-]{36})$/.exec(request.url ?? '')
    const state = match && cases.get(match[2])
    if (!state || state.expiresAt <= Date.now() || request.method !== 'GET') return reply(response, 404, { error: 'unavailable' })
    const operation = match[1]
    if (operation !== 'public' && !tokenEquals(request.headers.authorization, `Bearer ${state.canary}`)) return reply(response, 401, { error: 'unauthorized' })
    state.counts[operation]++
    if (operation === 'protected') notifyProtected(state)
    if (operation === 'echo') return reply(response, 200, { syntheticEcho: state.canary })
    if (operation === 'redirect') return reply(response, 302, {}, { location: `${config.upstreamOrigin}/v1/protected/${state.caseId}` })
    reply(response, 200, { caseId: state.caseId, challenge: state.challenge })
  }
  const egress = createServer((request, response) => {
    void handle(request, response).catch(() => reply(response, 400, { error: 'fixture_refused' }))
  })
  async function handle(request, response) {
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { fixtureId: config.fixtureId, ready: true })
    if (request.method === 'GET' && request.url === '/client.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); response.end(clientSource); return
    }
    if (request.method !== 'POST') return reply(response, 404, { error: 'unavailable' })
    const bytes = await body(request)
    if (request.url === '/control') {
      if (!tokenEquals(request.headers.authorization, `Bearer ${config.controlToken}`)) return reply(response, 401, { error: 'unauthorized' })
      const value = JSON.parse(bytes)
      if (!UUID.test(value.caseId ?? '')) return reply(response, 400, { error: 'scope' })
      if (value.action === 'create' || value.action === 'create_production') {
        const production = value.action === 'create_production'
        if (cases.has(value.caseId) || (production ? !/^mikka1712s_[a-f0-9]{64}$/.test(value.canary ?? '')
          : !/^[a-f0-9]{64}$/.test(value.bootstrapToken ?? ''))) return reply(response, 409, { error: 'scope' })
        const state = { caseId: value.caseId, bootstrapToken: value.bootstrapToken,
          mode: production ? 'production_claim' : 'isolated_fixture',
          canary: production ? value.canary : `mikka1712s_${randomBytes(32).toString('hex')}`,
          key: production ? null : randomBytes(32).toString('hex'),
          challenge: randomBytes(24).toString('hex'), expiresAt: Date.now() + 12 * 60_000, issued: false,
          runId: null, waiting: new Set(), protectedWaiters: new Set(),
          counts: { public: 0, protected: 0, echo: 0, redirect: 0, ...(production ? { sdk: 0 } : {}) } }
        if (production) state.sdkResponse = `protected-sdk-${state.challenge}`
        cases.set(value.caseId, state)
        return reply(response, 200, { caseId: state.caseId, canarySha256: digest(state.canary),
          ...(production ? { sdkResponseSha256: digest(state.sdkResponse) } : {}),
          responseSha256: digest(JSON.stringify({ caseId: state.caseId, challenge: state.challenge })) })
      }
      const state = cases.get(value.caseId)
      if (!state) return reply(response, 404, { error: 'scope' })
      if (value.action === 'bind' && UUID.test(value.runId ?? '') && !state.runId) {
        state.runId = value.runId
        for (const wake of state.waiting) wake()
        notifyProtected(state)
        return reply(response, 200, { bound: true })
      }
      if (value.action === 'wait_protected' && state.mode === 'production_claim') {
        if (!state.runId || state.counts.protected === 0) await new Promise(resolve => {
          let timer
          const wake = () => { clearTimeout(timer); response.off('close', wake); state.protectedWaiters.delete(wake); resolve() }
          state.protectedWaiters.add(wake); response.once('close', wake); timer = setTimeout(wake, 240_000)
        })
        if (response.destroyed) return
        if (!cases.has(state.caseId) || !state.runId || state.counts.protected === 0) return reply(response, 408, { error: 'fixture_deadline' })
        return reply(response, 200, { caseId: state.caseId, runId: state.runId, protectedRequests: state.counts.protected })
      }
      if (value.action === 'receipt') return reply(response, 200, { caseId: state.caseId, issued: state.issued,
        ...(state.mode === 'production_claim' ? { mode: state.mode } : {}),
        runId: state.runId, rotated: state.rotated === true, counts: state.counts })
      if (value.action === 'delete') {
        cases.delete(value.caseId)
        for (const wake of [...state.waiting, ...state.protectedWaiters]) wake()
        return reply(response, 200, { deleted: true })
      }
      return reply(response, 409, { error: 'scope' })
    }
    const grantMatch = /^\/(grant|rotate)\/([a-f0-9-]{36})$/.exec(request.url ?? '')
    if (grantMatch) {
      const state = cases.get(grantMatch[2]), value = JSON.parse(bytes)
      if (!state || state.mode === 'production_claim' || state.expiresAt <= Date.now() || !UUID.test(value.runId ?? '')
        || !tokenEquals(value.bootstrapToken, state.bootstrapToken)) return reply(response, 403, { error: 'scope' })
      // One event wait handles a very fast task arriving before the owner's
      // dispatch response is bound. This is neither polling nor caller authority.
      if (!state.runId) await new Promise(resolve => {
        let timer
        const wake = () => { clearTimeout(timer); state.waiting.delete(wake); resolve() }
        state.waiting.add(wake); timer = setTimeout(wake, 30_000)
      })
      if (!cases.has(state.caseId) || value.runId !== state.runId) return reply(response, 403, { error: 'scope' })
      if (grantMatch[1] === 'rotate') {
        if (!state.issued || state.rotated) return reply(response, 409, { error: 'scope' })
        state.key = randomBytes(32).toString('hex'); state.rotated = true
        return reply(response, 200, { rotated: true })
      }
      if (state.issued) return reply(response, 409, { error: 'already_issued' })
      state.issued = true
      const now = Date.now(), env = { WORKSPACE_SECRETS_KEY: state.key }
      const input = { ownerId: `fixture:${config.fixtureId}`, workspaceId: null, repository: 'alexj11324/Mikka-handoff',
        runId: state.runId, deviceId: state.caseId, deviceTokenId: state.caseId, attempt: 1,
        name: 'SYNTHETIC_PROTECTED', secretId: state.caseId, revision: digest(state.canary), secret: state.canary,
        leaseExpiresAt: now + 90_000,
        http: { origin: config.upstreamOrigin, header: 'authorization', prefix: 'Bearer ', rules:
          ['protected', 'echo', 'redirect'].map(operation => ({ method: 'GET', path: `/v1/${operation}/${state.caseId}`, match: 'exact' })) } }
      const grant = issueEgressCapability(input, now, env)
      const expired = issueEgressCapability({ ...input, leaseExpiresAt: now - 10_000 }, now - 100_000, env)
      return reply(response, 200, { version: 1, endpoint: `${config.egressOrigin}/egress/${state.runId}`,
        grants: [grant], unavailable: [], expiredCapability: expired.capability })
    }
    const match = /^\/egress\/([a-f0-9-]{36})$/.exec(request.url ?? '')
    const state = match && [...cases.values()].find(item => item.runId === match[1])
    if (!state || state.mode === 'production_claim' || state.expiresAt <= Date.now()) return reply(response, 403, { error: 'scope' })
    const input = new Request(`${config.egressOrigin}${request.url}`, { method: 'POST',
      headers: new Headers(Object.entries(request.headers).flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : [])), body: bytes })
    const result = await taskSecretEgressResponse(input, state.runId,
      (envelope, expected, options) => executeEgressRequest(envelope, expected, { ...options, env: { WORKSPACE_SECRETS_KEY: state.key } }))
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()))
  }
  for (const server of [upstream, egress]) { server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.maxHeadersCount = 32 }
  await Promise.all([[upstream, upstreamPort], [egress, egressPort]].map(([server, port]) => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, listenHost, resolve)
  })))
  return { upstreamAddress: upstream.address(), egressAddress: egress.address(),
    close: async () => {
      for (const state of cases.values()) for (const wake of [...state.waiting, ...state.protectedWaiters]) wake()
      cases.clear()
      await Promise.all([upstream, egress].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
    } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
    await startFixture(config, await readFile(process.argv[3], 'utf8'))
    process.stdout.write('MIKKA_1712_FIXTURE_READY\n')
  } catch { process.stderr.write('fixture_start_failed\n'); process.exitCode = 1 }
}
