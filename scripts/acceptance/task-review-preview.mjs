/** Normal owner API acceptance. Never creates a VM or calls a provider SDK.
 * The capability URL, preview cookie and PTY output remain in this closure.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { request as httpsRequest } from 'node:https'
import { observeHmr } from '../e2b/workspace-ingress-acceptance.mjs'
import { withPreviewTerminal, verifyTerminalRefusal } from './task-review-terminal.mjs'
import { runtimeAssertionScript } from './coding-workspace-native.mjs'

const require = createRequire(import.meta.url)
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ORIGIN = 'https://app.aspectlylabs.com'
const NODE = '/opt/mikka/runtime/node/bin/node'
const NPM = '/opt/mikka/runtime/node/lib/node_modules/npm/bin/npm-cli.js'
const CODES = new Set(['scope', 'version', 'fixture', 'install', 'server', 'response', 'capability', 'authentication',
  'http', 'hmr', 'raw_exposed', 'remote_cleanup', 'end', 'reclaimed', 'terminal', 'deadline'])
const fail = (code, cause) => { throw Object.assign(new Error(`preview_acceptance_${code}`, cause ? { cause } : undefined), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const safe = error => ({ code: CODES.has(error?.code) ? `preview_acceptance_${error.code}` : 'preview_acceptance_failed' })

async function text(response, limit = 2 * 1024 * 1024) {
  check(response.body, 'response')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length; check(length <= limit, 'response'); chunks.push(part.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
const json = async response => {
  try { return JSON.parse(await text(response, 16384)) } catch (cause) { fail('response', cause) }
}

/** Node fetch rewrites Sec-Fetch-Mode; use HTTPS for the real iframe bootstrap. */
export function previewBootstrap(url, { requestImpl = httpsRequest, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = requestImpl(url, { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe', 'Cache-Control': 'no-cache', Connection: 'close' },
    signal: AbortSignal.timeout(timeoutMs) }, incoming => {
      const chunks = []; let length = 0
      incoming.on('data', part => {
        length += part.length
        if (length > 65536) incoming.destroy(new Error('preview_acceptance_response'))
        else chunks.push(part)
      })
      incoming.on('error', cause => reject(Object.assign(new Error('preview_acceptance_response', { cause }), { code: 'response' })))
      incoming.on('end', () => {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item)
            else if (value !== undefined) headers.set(name, value)
          }
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }))
        } catch (cause) { reject(Object.assign(new Error('preview_acceptance_response', { cause }), { code: 'response' })) }
      })
    })
    outgoing.on('error', cause => reject(Object.assign(new Error('preview_acceptance_response', { cause }), { code: 'response' })))
    outgoing.end()
  })
}

export function previewCapability(value, sandboxId) {
  check(value?.running === true && typeof value.url === 'string' && value.url.length <= 8192
    && /^[A-Za-z0-9_-]{1,128}$/.test(sandboxId ?? ''), 'capability')
  let url
  try { url = new URL(value.url) } catch (cause) { fail('capability', cause) }
  const match = /^([1-9][0-9]{0,4})-([A-Za-z0-9_-]+)\.(e2b\.app|e2b\.dev)$/.exec(url.hostname)
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && match && Number(match[1]) < 65536 && match[2] === sandboxId
    && url.pathname === '/__mikka/preview/open' && [...url.searchParams.keys()].join(',') === 'ticket'
    && url.searchParams.get('ticket')?.length > 0, 'capability')
  return { url, origin: url.origin, suffix: `${sandboxId}.${match[3]}` }
}

async function upload(terminal, path, bytes) {
  const encoded = bytes.toString('base64')
  await terminal.run(`: > ${quote(path + '.b64')}`)
  for (let offset = 0; offset < encoded.length; offset += 10000)
    await terminal.run(`printf '%s' ${quote(encoded.slice(offset, offset + 10000))} >> ${quote(path + '.b64')}`)
  const script = `const f=require('node:fs'),c=require('node:crypto'),p=${JSON.stringify(path)},b=Buffer.from(f.readFileSync(p+'.b64','utf8'),'base64');if(c.createHash('sha256').update(b).digest('hex')!==${JSON.stringify(hash(bytes))})process.exit(1);f.writeFileSync(p,b,{mode:0o600});f.unlinkSync(p+'.b64')`
  await terminal.run(`${NODE} -e ${quote(script)}`)
}

/** Files and dependencies are the same immutable fixture as private HMR proof.
 * Upload goes through owner POST input; it is not a provider file-write bypass.
 */
export async function preparePreviewFramework(terminal, { fixtureId, framework, files }) {
  check(UUID.test(fixtureId ?? '') && ['vite', 'next'].includes(framework), 'fixture')
  const root = `.mikka-review-${fixtureId}`, directory = `${root}/${framework}`
  const port = 32000 + Number.parseInt(fixtureId.slice(0, 4), 16) % 15000
  check(files && Buffer.isBuffer(files['package.json']) && Buffer.isBuffer(files['package-lock.json']), 'fixture')
  const marker = `mikka-preview-${framework}-${fixtureId}`
  const fixture = framework === 'next' ? {
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.jsx': `export default function Page(){return <main>${marker}-v1</main>}`,
  } : { 'index.html': `<main>${marker}-v1</main><script type="module" src="/main.js"></script>`,
    'main.js': 'export const version = 1; if (import.meta.hot) import.meta.hot.accept();' }
  await terminal.run(`test ! -e ${quote(root)}; install -d -m 700 ${quote(directory + '/app')}`)
  for (const [name, bytes] of Object.entries(files)) {
    check(['package.json', 'package-lock.json'].includes(name) && bytes.length <= 131072, 'fixture')
    await upload(terminal, `${root}/${name}`, bytes)
  }
  for (const [name, value] of Object.entries({ 'package.json': JSON.stringify({ name: `mikka-preview-${framework}`, private: true }), ...fixture }))
    await upload(terminal, `${directory}/${name}`, Buffer.from(value))
  await terminal.run(`cd ${quote(root)}; ${NODE} ${NPM} ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1`, { timeoutMs: 180000 })
  await terminal.run(`cd ${quote(root)}; ${NODE} -e ${quote("for(const [n,v] of Object.entries({next:'16.4.1',vite:'8.3.6',react:'19.3.1','react-dom':'19.3.1'}))if(require(n+'/package.json').version!==v)process.exit(1)")}`)
  const binary = framework === 'next' ? '../node_modules/next/dist/bin/next' : '../node_modules/vite/bin/vite.js'
  const args = framework === 'next' ? `dev --webpack --hostname 127.0.0.1 --port ${port}` : `--host 127.0.0.1 --port ${port} --strictPort`
  await terminal.run(`cd ${quote(directory)}; NEXT_TELEMETRY_DISABLED=1 NO_COLOR=1 ${NODE} ${binary} ${args} &`)
  await terminal.expectText(framework === 'next' ? 'Ready in' : 'Local:', { timeoutMs: 90000 })
  return { directory, port, marker, frameworkLockSha256: hash(files['package-lock.json']),
    async update() {
      const name = framework === 'next' ? 'app/page.jsx' : 'main.js'
      await upload(terminal, `${directory}/${name}`, Buffer.from(fixture[name].replace('-v1', '-v2').replace('version = 1', 'version = 2')))
    } }
}

export async function verifyPreviewRefusal({ client, taskId, status, code, workspaceId }) {
  check(UUID.test(taskId ?? '') && [403, 409].includes(status)
    && (!workspaceId || UUID.test(workspaceId))
    && ['not_owner_terminal', 'review_scope_denied', 'review_machine_gone'].includes(code), 'scope')
  const path = `/api/tasks/${taskId}/review/preview`
  const response = await client.request(path, workspaceId ? { headers: { 'x-mikka-workspace-id': workspaceId } } : {})
  const body = await json(response)
  check(response.status === status && body.error === code, 'response')
  return { method: 'GET', path, status, error: code }
}

/** These are requests to the application, never direct requests to the supplied
 * hostile targets. The owner must get a closed validation error and no URL.
 */
export async function verifyPreviewTargetRefusals({ client, taskId }) {
  check(UUID.test(taskId ?? ''), 'scope')
  const evidence = []
  for (const query of ['?url=http://169.254.169.254/', '?port=3000&port=3001',
    '?sandboxId=other-sandbox&runId=00000000-0000-4000-8000-000000000000']) {
    const path = `/api/tasks/${taskId}/review/preview${query}`, response = await client.request(path)
    const body = await json(response)
    check(response.status === 400 && body.error === 'review_preview_unavailable' && body.code === body.error
      && body.detail === 'configuration' && Object.keys(body).sort().join(',') === 'code,detail,error', 'response')
    evidence.push({ method: 'GET', path, status: 400, error: body.error, detail: body.detail, capabilityReturned: false })
  }
  return evidence
}

export async function verifyExistingTaskPreview(options, { fetchImpl = fetch, bootstrap = previewBootstrap,
  Socket = require('next/dist/compiled/ws'), observe = observeHmr, terminal = withPreviewTerminal, fixtureFiles } = {}) {
  const { client, taskId, runId, fixtureId, harness, sandboxId, expectedBuild, beforeEnd, workerSha, workerSourceCommit } = options
  check(UUID.test(taskId ?? '') && UUID.test(runId ?? '') && UUID.test(fixtureId ?? '')
    && ['claude_code', 'codex'].includes(harness) && typeof beforeEnd === 'function'
    && /^[a-f0-9]{40}$/.test(workerSha ?? '') && /^[a-f0-9]{40}$/.test(workerSourceCommit ?? ''), 'scope')
  const framework = harness === 'claude_code' ? 'vite' : 'next', observers = []
  const report = { version: 1, issue: 1724, taskId, runId, build: expectedBuild, framework, status: 'running', checks: {} }
  let phase = 'fixture'
  try {
    const files = fixtureFiles ?? Object.fromEntries(await Promise.all(['package.json', 'package-lock.json'].map(async name =>
      [name, await readFile(new URL(`../e2b/fixtures/preview-frameworks/${name}`, import.meta.url))])))
    const result = await terminal(options, async controls => {
      try {
        phase = 'version'
        await controls.run(runtimeAssertionScript({ workerSha, workerSourceCommit }))
        report.runtime = { workerSha, sourceCommit: workerSourceCommit, rootOwnedReadOnlyMarker: true }
        const path = `/api/tasks/${taskId}/review/preview`
        const deadline = () => {
          check(Number.isSafeInteger(controls.expiresAt) && controls.expiresAt > Date.now(), 'deadline')
          return Math.min(12000, controls.remaining())
        }
        const request = async (url, headers, timeout = deadline()) => fetchImpl(url, { headers, redirect: 'manual', cache: 'no-store',
          signal: AbortSignal.timeout(timeout) })
        phase = 'invalid_targets'
        report.checks.invalidTargets = await verifyPreviewTargetRefusals({ client, taskId })
        phase = 'empty'
        const empty = await client.request(path), emptyBody = await json(empty)
        check(empty.status === 404 && emptyBody.running === false, 'response')
        report.checks.noServer = { method: 'GET', path, status: 404, running: false }
        phase = 'install'
        const server = await preparePreviewFramework(controls, { fixtureId, framework, files })
        report.frameworkLockSha256 = server.frameworkLockSha256
        phase = 'discovery'
        const discovered = await client.request(`${path}?port=${server.port}`), body = await json(discovered)
        check(discovered.status === 200, 'response')
        const capability = previewCapability(body, sandboxId), { origin } = capability
        report.checks.discovery = { method: 'GET', path: `${path}?port=${server.port}`, status: 200,
          running: true, url: '[redacted one-use capability]', isolatedOriginSha256: hash(origin) }
        phase = 'raw'
        let rawStatus = 0, rawBody = ''
        const rawDeadline = deadline()
        try { const raw = await request(`https://${server.port}-${capability.suffix}/`, undefined, rawDeadline); rawStatus = raw.status; rawBody = await text(raw) }
        catch (cause) { if (cause?.code && CODES.has(cause.code)) throw cause }
        deadline()
        check((rawStatus === 0 || rawStatus >= 400) && !rawBody.includes(server.marker), 'raw_exposed')
        report.checks.rawPortDenied = { status: rawStatus, markerAbsent: true }
        phase = 'authentication'
        const anonymous = await request(origin + '/'); report.checks.anonymousStatus = anonymous.status
        await anonymous.body?.cancel(); check([401, 403].includes(anonymous.status), 'authentication')
        const entry = await bootstrap(capability.url.href, { timeoutMs: deadline() })
        const setCookie = entry.headers.get('set-cookie') ?? '', csp = entry.headers.get('content-security-policy') ?? ''
        const html = await text(entry, 65536), nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1]
        check(entry.status === 200 && /^__Host-mikka_preview=[^;\s]+;/.test(setCookie)
          && ['Secure', 'HttpOnly', 'Partitioned'].every(flag => new RegExp(`;\\s*${flag}(?:;|$)`, 'i').test(setCookie))
          && /;\s*SameSite=None(?:;|$)/i.test(setCookie) && /;\s*Path=\/(?:;|$)/i.test(setCookie)
          && !/;\s*Domain=/i.test(setCookie) && nonce && csp.includes("default-src 'none'")
          && csp.includes(`frame-ancestors ${ORIGIN}`) && entry.headers.get('referrer-policy') === 'no-referrer'
          && entry.headers.get('content-type')?.startsWith('text/html') && html.includes(`<script nonce="${nonce}">`)
          && html.includes('history.replaceState(null,"","/")') && html.includes('location.replace("/")'), 'authentication')
        const headers = { Cookie: setCookie.split(';')[0], Origin: origin, 'Sec-Fetch-Site': 'same-origin' }
        report.checks.bootstrap = { status: 200, isolatedCookie: true, partitioned: true, frameAncestor: ORIGIN, noReferrer: true }
        const replay = await bootstrap(capability.url.href, { timeoutMs: deadline() })
        report.checks.replayStatus = replay.status; await replay.body?.cancel(); check([401, 403].includes(replay.status), 'authentication')
        phase = 'http'
        const page = await request(origin + '/', headers), document = await text(page)
        check(page.status === 200 && document.includes(server.marker + '-v1'), 'http')
        let wsPath, protocols = []
        if (framework === 'next') {
          const asset = /<script[^>]+src="([^"]+)"/.exec(document)?.[1]?.replaceAll('&amp;', '&')
          const id = /self\.__next_r="([^"]+)"/.exec(document)?.[1]
          check(asset?.startsWith('/') && !asset.startsWith('//') && id && id.length < 256, 'http')
          const assetResponse = await request(new URL(asset, origin).href, headers)
          check(assetResponse.status === 200 && (await text(assetResponse)).length > 100, 'http')
          wsPath = '/_next/hmr?id=' + encodeURIComponent(id)
        } else {
          const asset = await request(origin + '/@vite/client', headers), value = await text(asset)
          const token = /const wsToken = ['"]([^'"]+)['"]/.exec(value)?.[1]
          check(asset.status === 200 && token && token.length < 256, 'http')
          const module = await request(origin + '/main.js', headers)
          check(module.status === 200 && (await text(module)).includes('import.meta.hot'), 'http')
          wsPath = '/?token=' + encodeURIComponent(token); protocols = ['vite-hmr']
        }
        report.checks.http = { htmlStatus: 200, assetStatus: 200, fixtureMarker: true }
        phase = 'hmr'
        const observer = observe(origin.replace('https:', 'wss:') + wsPath, protocols, headers, Socket)
        observers.push(observer); await observer.ready(); observer.arm(framework === 'next')
        await server.update(); const hmrEvent = await observer.updated()
        check(['built', 'serverComponentChanges', 'update', 'full-reload'].includes(hmrEvent), 'hmr')
        report.checks.hmrEvent = hmrEvent
        const updated = await request(origin + (framework === 'next' ? '/' : '/main.js'), headers)
        check(updated.status === 200 && (await text(updated)).includes(framework === 'next' ? server.marker + '-v2' : 'version = 2'), 'hmr')
        phase = 'remote_cleanup'
        const cleaned = await beforeEnd(controls)
        check(cleaned?.status === 'passed' && Number.isSafeInteger(cleaned.prNumber) && cleaned.prNumber > 0
          && /^[a-f0-9]{40}$/.test(cleaned.candidateSha ?? '') && cleaned.prClosed === true
          && cleaned.branchDeleted === true && cleaned.defaultBranchUnchanged === true, 'remote_cleanup')
        report.remoteCleanup = { status: 'passed', prNumber: cleaned.prNumber, candidateSha: cleaned.candidateSha,
          prClosed: true, branchDeleted: true, defaultBranchUnchanged: true }
        // Closing the new PR must not be mistaken for machine-end revocation.
        const alive = await request(origin + '/', headers)
        check(alive.status === 200 && (await text(alive)).includes(server.marker), 'http')
        const aliveSocket = observe(origin.replace('https:', 'wss:') + wsPath, protocols, headers, Socket)
        observers.push(aliveSocket); await aliveSocket.ready()
        for (const item of observers) item.expectRevoke()
        report.checks.aliveAfterRemoteCleanup = { httpStatus: 200, activeWebSockets: observers.length }
        phase = 'end'
        deadline()
        const ended = await client.json(`/api/threads/${runId}/machine`, post({ action: 'end' }), 120000)
        check(ended?.runId === runId && ended.state === 'ended', 'end')
        const machine = await client.rpc('agents.getThreadMachine', [taskId, runId])
        check(machine?.kind === 'cloud' && machine.state === 'ended' && machine.cloud === null, 'end')
        // An expired lease is not evidence that the requested machine end
        // revoked a live capability. Keep this original absolute TTL.
        deadline()
        report.checks.machineEnd = { method: 'POST', path: `/api/threads/${runId}/machine`, status: 200,
          state: 'ended', resourceReferencesCleared: true }
        phase = 'reclaimed'
        report.checks.webSocketsRevoked = await Promise.all(observers.map(item => item.revoked()))
        let revokedStatus = 0
        const revokedDeadline = deadline()
        try { const response = await request(origin + '/', headers, revokedDeadline); revokedStatus = response.status; await response.body?.cancel() }
        catch (cause) { if (cause?.code && CODES.has(cause.code)) throw cause }
        deadline()
        check(revokedStatus === 0 || revokedStatus >= 400, 'reclaimed')
        report.checks.oldPreviewDenied = { status: revokedStatus }
        report.checks.previewReclaimed = await verifyPreviewRefusal({ client, taskId, status: 409, code: 'review_machine_gone' })
        report.checks.terminalReclaimed = []
        for (const method of ['GET', 'POST']) report.checks.terminalReclaimed.push(await verifyTerminalRefusal({ client, taskId,
          status: 409, codes: ['review_machine_gone'], method }))
        return { completed: true }
      } catch (cause) { report.failure = { phase, ...safe(cause) }; throw cause }
    })
    report.terminal = { status: result.status, cleanup: result.cleanup, ...(result.failure ? { failure: result.failure } : {}) }
    check(result.status === 'passed' && result.value?.completed === true, 'terminal')
    report.status = 'passed_for_requested_scope'
  } catch (cause) { report.status = 'failed'; report.failure ??= { phase, ...safe(cause) } }
  finally { for (const observer of observers) observer.close() }
  return report
}
