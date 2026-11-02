// The local half of the temporary E2B relay. Only the selected device's v1
// requests reach the loopback test application. Cookies are never forwarded.
import { timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'

const forbidden = new Set(['host', 'connection', 'transfer-encoding', 'content-length', 'content-encoding', 'keep-alive', 'set-cookie', 'cookie'])
export function relayTarget(request, { localOrigin, relayOrigin }) {
  const local = new URL(localOrigin), remote = new URL(relayOrigin)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || local.protocol !== 'http:' || local.pathname !== '/') throw Error('Loopback origin required')
  if (remote.protocol !== 'https:' || remote.pathname !== '/' || remote.username || remote.password || request.origin !== remote.origin) throw Error('Foreign relay origin')
  if (typeof request.path !== 'string' || request.path.includes('\\') || !(request.path.startsWith('/mikka/v1/') || (request.scope === 'mcp' && request.path === '/mikka/api/mcp' && request.method === 'POST'))) throw Error('Relay path refused')
  const url = new URL(request.path, local)
  if (url.origin !== local.origin || url.hash || url.username || url.password || url.pathname !== request.path.split('?')[0] || decodeURIComponent(decodeURIComponent(url.pathname)) !== url.pathname || url.pathname.includes('//')) throw Error('Relay path refused')
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) || !/^[0-9a-f-]{36}$/.test(request.id)) throw Error('Relay request refused')
  return url
}

/** The only Git backend this acceptance relay can reach is the owning
 * dev:local fixture. Run CGI directly without a shell or inherited secrets. */
export async function fixtureGitResponse(request, { barePath, relayOrigin, signal }) {
  const remote = new URL(relayOrigin), url = new URL(request.path, remote)
  const prefix = '/mikka/v1/git/core-loop.git'
  if (request.origin !== remote.origin || url.origin !== remote.origin || url.hash || !url.pathname.startsWith(`${prefix}/`)) throw Error('Foreign Git fixture')
  const suffix = url.pathname.slice(prefix.length)
  const upload = (request.method === 'GET' && suffix === '/info/refs' && url.search === '?service=git-upload-pack') || (request.method === 'POST' && suffix === '/git-upload-pack' && !url.search)
  if (!upload || !barePath?.endsWith('/origin.git')) throw Error('Git fixture operation refused')
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_HTTP_EXPORT_ALL: '1',
    GIT_PROJECT_ROOT: dirname(barePath), PATH_INFO: `/${basename(barePath)}${suffix}`, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers?.['content-type'] ?? '', CONTENT_LENGTH: String(Buffer.from(request.body ?? '', 'base64').length),
    SERVER_PROTOCOL: 'HTTP/1.1', REMOTE_USER: 'isolated-fixture-reader', HTTP_GIT_PROTOCOL: request.headers?.['git-protocol'] ?? '',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.receivepack', GIT_CONFIG_VALUE_0: 'false' }
  const child = spawn('git', ['http-backend'], { env, signal, stdio: ['pipe', 'pipe', 'pipe'] })
  const chunks = [], errors = []
  child.stdout.on('data', part => chunks.push(part)); child.stderr.on('data', part => errors.push(part))
  child.stdin.end(Buffer.from(request.body ?? '', 'base64'))
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
  if (code !== 0) throw Error('Git fixture backend failed')
  const bytes = Buffer.concat(chunks), crlf = bytes.indexOf('\r\n\r\n'), lf = bytes.indexOf('\n\n')
  const index = crlf >= 0 ? crlf : lf, separator = crlf >= 0 ? 4 : 2
  if (index < 0) throw Error('Invalid Git CGI response')
  const headers = {}, lines = bytes.subarray(0, index).toString().split(/\r?\n/)
  let status = 200
  for (const line of lines) {
    const colon = line.indexOf(':'); if (colon < 0) continue
    const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim()
    if (key === 'status') status = Number.parseInt(value)
    else if (!forbidden.has(key)) headers[key] = value
  }
  return new Response(bytes.subarray(index + separator), { status, headers })
}

export async function startLocalRelay({ localOrigin, relayOrigin, deviceToken, controlToken, signal, barePath, send = fetch, observe = () => {} }) {
  if (!/^orv_[A-Za-z0-9_-]{43}$/.test(deviceToken) || !/^[A-Za-z0-9_-]{43}$/.test(controlToken) || timingSafeEqual(Buffer.from(deviceToken.slice(4)), Buffer.from(controlToken))) throw Error('Distinct relay credentials required')
  const controller = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let mcp
  const control = async (path, options = {}) => {
    const response = await send(`${relayOrigin}${path}`, { ...options, headers: { ...options.headers, authorization: `Bearer ${controlToken}` }, signal: activeSignal, redirect: 'error' })
    if (!response.ok) throw Error(`Relay control HTTP ${response.status}`)
    return response
  }
  const handle = async request => {
    const url = request.scope === 'git' ? null : relayTarget(request, { localOrigin, relayOrigin })
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => !forbidden.has(name.toLowerCase()) && (['content-type', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-mikka-'))))
    // Next must sign the same public HTTPS issuer the cloud daemon verifies.
    // Host and forwarded headers come from the configured relay, never a peer.
    headers.host = new URL(relayOrigin).host
    headers['x-forwarded-host'] = headers.host
    headers['x-forwarded-proto'] = 'https'
    if (request.scope === 'mcp' && (!mcp || request.runId !== mcp.runId || performance.now() >= mcp.until)) throw Error('Foreign MCP run')
    headers.authorization = `Bearer ${request.scope === 'mcp' ? mcp.token : deviceToken}`
    const began = performance.now()
    let response = request.scope === 'git' ? await fixtureGitResponse(request, { barePath, relayOrigin, signal: activeSignal })
      : await send(url, { method: request.method, headers, ...(request.method === 'GET' ? {} : { body: Buffer.from(request.body ?? '', 'base64') }), redirect: 'error', signal: activeSignal })
    const returned = Object.fromEntries([...response.headers].filter(([name]) => !forbidden.has(name.toLowerCase())))
    // Verify issuer on the actual signed claim response before it can reach
    // the daemon; there is no relaxed policy validation for this test path.
    if (request.path.endsWith('/claim') && response.ok) {
      const context = await response.clone().json()
      const issuer = context.policySnapshot?.payload?.issuer
      if (issuer !== `${relayOrigin}/mikka`) throw Error('Relay policy issuer mismatch')
      if (context.mcp) {
        if (mcp && mcp.runId !== context.runId) throw Error('Foreign MCP claim')
        const endpoint = new URL(context.mcp.url)
        if (![relayOrigin, localOrigin].includes(endpoint.origin) || endpoint.pathname !== '/mikka/api/mcp' || endpoint.search || endpoint.hash) throw Error('Foreign MCP endpoint')
        const githubScope = context.github ? { issueId: context.issueId, repository: context.github.repository, branch: context.github.branch } : {}
        await control('/control/bind-mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: context.runId, token: context.mcp.token, ...githubScope }) })
        mcp = { runId: context.runId, token: context.mcp.token, until: performance.now() + 900_000, ...githubScope }
        // The app's configured MCP URL is loopback. Move this single scoped
        // endpoint through the test relay; the server-issued token and signed
        // policy snapshot remain byte-for-byte unchanged.
        context.mcp.url = `${relayOrigin}/mikka/api/mcp`
        if (context.github) {
          const gitToken = new URL(context.github.endpoint)
          if (![localOrigin, relayOrigin].includes(gitToken.origin) || gitToken.pathname !== '/mikka/api/runs/github-token' || gitToken.search || gitToken.hash) throw Error('Foreign GitHub token endpoint')
          context.github.endpoint = `${relayOrigin}/mikka/api/runs/github-token`
        }
        response = Response.json(context, { status: response.status, headers: returned })
      }
      observe({ type: 'claim', status: response.status, issuer })
    } else if (request.path.includes('/policy-snapshot') && response.ok) {
      const value = await response.clone().json()
      if ((value.issuer ?? value.payload?.issuer) !== `${relayOrigin}/mikka`) throw Error('Relay policy issuer mismatch')
    }
    await control(`/control/${request.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: response.status, headers: returned }) })
    if (response.body) {
      for await (const bytes of response.body) await control(`/control/${request.id}/chunk`, { method: 'POST', body: bytes })
    }
    await control(`/control/${request.id}/end`, { method: 'POST' })
    if (mcp && request.path.endsWith(`/runs/${mcp.runId}/complete`) && response.ok) { await control('/control/bind-mcp', { method: 'DELETE' }); mcp = undefined }
    observe({ type: 'request', path: request.path.split('?')[0], method: request.method, status: response.status, elapsedMs: Math.round(performance.now() - began) })
  }
  const workers = Array.from({ length: 6 }, async () => {
    while (!activeSignal.aborted) {
      try {
        const response = await control('/control/next')
        if (response.status === 204) continue
        await handle(await response.json())
      } catch (error) {
        if (activeSignal.aborted) return
        controller.abort(error)
        throw error
      }
    }
  })
  const done = Promise.all(workers)
  void done.catch(() => {})
  return { done,
    bindDevice: async (token, deviceId) => {
      if (!/^orv_[A-Za-z0-9_-]{43}$/.test(token)) throw Error('Invalid relay device')
      await control('/control/bind-device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, deviceId }) })
      deviceToken = token
    },
    stop: async () => { controller.abort(); await done.catch(() => {}) },
  }
}
