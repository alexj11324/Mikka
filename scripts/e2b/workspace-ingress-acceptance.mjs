#!/usr/bin/env node
/** Actual private derived-template acceptance. No model, human task, production
 * store, template publication or credential delivery occurs in this driver.
 * Capabilities stay in memory or root-only consumed control files. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { request as httpsRequest } from 'node:https'
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const PURPOSE = 'mikka-workspace-ingress-acceptance'
const MARKER = 'mikka-workspace-ingress-synthetic-v1'
const GATEWAY = '/opt/mikka/worker/scripts/e2b/preview-gateway.py'
const GUARD = '/opt/mikka/runtime/ingress-v1/guard.py'
const NODE = '/opt/mikka/runtime/node/bin/node'
const RAW_NAMES = ['userLoopback4', 'userPublic4', 'userLoopback6']
const hash = value => createHash('sha256').update(value).digest('hex')
const CODES = new Set(['configuration', 'source', 'candidate', 'scope', 'guard', 'process', 'ready', 'ports',
  'positive_control', 'raw_exposed', 'outbound', 'dependencies', 'preview', 'authentication', 'http', 'hmr',
  'revoke', 'takeover', 'takeover_bind', 'takeover_not_denied', 'resume', 'terminal', 'cleanup', 'journal', 'internal'])
const error = (code, cause) => Object.assign(new Error(`workspace_acceptance_${code}`, cause ? { cause } : undefined), { receiptCode: code })
const check = (ok, code) => { if (!ok) throw error(code) }
const safeFailure = cause => CODES.has(cause?.receiptCode) ? cause.receiptCode : 'internal'
const delay = milliseconds => new Promise(accept => setTimeout(accept, milliseconds))
const IDENTITY_OPERATIONS = new Set(['get_info', 'source_command', 'source_compare'])
const IDENTITY_ERROR_TYPES = new Set(['Error', 'TypeError', 'SyntaxError', 'CommandExitError', 'ConnectError',
  'SandboxError', 'SandboxNotFoundError', 'SandboxNotRunningError', 'SandboxUnreachableError', 'FileNotFoundError',
  'NotFoundError', 'ServiceBusyError', 'RateLimitError', 'AuthenticationError', 'InvalidArgumentError',
  'NotEnoughSpaceError', 'TimeoutError', 'AbortError'])
const diagnosticInteger = (value, minimum, maximum) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum ? value : null
const PREVIEW_ERRORS = new Set(['invalid_scope', 'invalid_port', 'worktree_unavailable', 'port_limit',
  'authorization_revoked', 'authorization_expired', 'server_stopped', 'control_unavailable',
  'firewall_unsupported', 'firewall_unavailable', 'infrastructure_only', 'origin_limit'])
const PREVIEW_PROBE_OUTCOMES = new Set(['timeout', 'connection_failed', 'http_error', 'pin_changed', 'invalid_status'])

// SDK messages, command output, request URLs and headers must never enter a
// receipt. Inspect only bounded command stderr for these fixed classifications.
export function identityDiagnostic(cause, operation) {
  if (!IDENTITY_OPERATIONS.has(operation)) return null
  const result = { operation, exceptionChain: [], truncated: false,
    stderr: { gitDubiousOwnership: false, gitNotRepository: false, oversized: false } }
  const seen = new Set()
  try {
    let current = cause
    for (let depth = 0; current != null && depth < 4; depth++) {
      if (seen.has(current)) { result.truncated = true; break }
      seen.add(current)
      const type = IDENTITY_ERROR_TYPES.has(current?.name) ? current.name : 'other'
      result.exceptionChain.push({ type,
        reason: type === 'Error' && current.message === 'Expected start event' ? 'process_start_event_missing'
          : type === 'SandboxError' && current.message === 'Process exited without a result' ? 'process_result_missing' : null,
        exitCode: type === 'CommandExitError' ? diagnosticInteger(current.exitCode, -255, 255) : null,
        httpStatus: diagnosticInteger(current?.statusCode, 100, 599),
        connectCode: type === 'ConnectError' ? diagnosticInteger(current.code, 1, 16) : null })
      if (type === 'CommandExitError' && typeof current.stderr === 'string') {
        if (Buffer.byteLength(current.stderr) > 16_384) result.stderr.oversized = true
        else {
          result.stderr.gitDubiousOwnership ||= current.stderr.includes('fatal: detected dubious ownership in repository at ')
          result.stderr.gitNotRepository ||= current.stderr.includes('fatal: not a git repository (or any of the parent directories): .git')
        }
      }
      current = current?.cause
      if (depth === 3 && current != null) result.truncated = true
    }
  } catch { result.truncated = true }
  return result
}

async function bounded(promise, milliseconds, code) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error(code)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

async function atomic(path, value, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = JSON.stringify(value, null, 2) + '\n'
  if (exclusive) return writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  const temporary = `${path}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
}

export function guardReceipt(value, expectedDigest, before) {
  check(value?.ok === true && value.version === 1 && value.sourceSha256 === expectedDigest
    && DIGEST.test(expectedDigest) && UUID.test(value.bootId ?? '')
    && Number.isSafeInteger(value.installedTicks) && value.installedTicks > 0
    && value.preparedBeforeWorker === true && value.rulesVerified?.ipv4 === true && value.rulesVerified?.ipv6 === true
    && Number.isSafeInteger(value.workerPid) && value.workerPid > 1
    && Number.isSafeInteger(value.workerStartTicks) && value.workerStartTicks >= value.installedTicks
    && value.workerStartedAfterGuard === true
    && Array.isArray(value.providerPorts) && value.providerPorts[0] === 49983
    && value.providerPorts.length <= 2 && new Set(value.providerPorts).size === value.providerPorts.length
    && value.providerPorts.every(port => port === 49983 || port === 50005), 'guard')
  if (before) check(['sourceSha256', 'bootId', 'installedTicks', 'workerPid', 'workerStartTicks'].every(key => value[key] === before[key])
    && JSON.stringify(value.providerPorts) === JSON.stringify(before.providerPorts), 'resume')
  return Object.fromEntries(['ok', 'version', 'sourceSha256', 'bootId', 'installedTicks', 'providerPorts',
    'preparedBeforeWorker', 'rulesVerified', 'workerPid', 'workerStartTicks', 'workerStartedAfterGuard'].map(key => [key, value[key]]))
}

export function validPorts(ports, names = [...RAW_NAMES, 'rootMarked']) {
  check(ports && Object.keys(ports).length === names.length && names.every(name => Number.isInteger(ports[name])
    && ports[name] > 1024 && ports[name] < 65536 && ![49983, 50005, 6080, 6082, 6084].includes(ports[name]))
    && new Set(Object.values(ports)).size === names.length, 'ports')
  return ports
}

const publicOrigin = (sandbox, port) => {
  check(Number.isInteger(port) && port > 1024 && port < 65536, 'ports')
  const url = new URL(`https://${sandbox.getHost(port)}`)
  check(!url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash
    && /^[A-Za-z0-9.-]+\.(?:e2b\.app|e2b\.dev)$/.test(url.hostname), 'scope')
  return url.origin
}

async function request(url, fetchImpl, options = {}) {
  return fetchImpl(url, { ...options, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12_000) })
}

// Node fetch replaces Sec-Fetch-Mode with its internal request mode. Use the
// ordinary HTTPS transport for this one exact iframe-navigation contract.
function bootstrapRequest(url) {
  return new Promise((accept, reject) => {
    const outgoing = httpsRequest(url, { method: 'GET', headers: {
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe',
      'Cache-Control': 'no-cache', Connection: 'close',
    }, signal: AbortSignal.timeout(12_000) }, incoming => {
      const chunks = []; let bytes = 0
      incoming.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 65_536) incoming.destroy(error('http'))
        else chunks.push(chunk)
      })
      incoming.on('error', cause => reject(error('http', cause)))
      incoming.on('end', () => {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item)
            else if (value !== undefined) headers.set(name, value)
          }
          accept(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }))
        } catch (cause) { reject(error('http', cause)) }
      })
    })
    outgoing.on('error', cause => reject(error('http', cause)))
    outgoing.end()
  })
}

async function markerSample(url, fetchImpl) {
  try {
    const response = await request(url, fetchImpl, { headers: { connection: 'close' } })
    const text = await response.text()
    return { status: response.status, markerMatched: text === MARKER }
  } catch { return { status: null, markerMatched: false } }
}
const denied = value => value?.markerMatched === false && (value.status === null || value.status >= 400)

async function listenerWiring(sandbox, fetchImpl) {
  const handles = []
  try {
    const setup = "python3 - <<'MIKKA_LISTENER_SETUP'\nimport json,socket,pathlib\nfor port in (6080,6082):\n s=socket.socket();s.settimeout(1)\n assert s.connect_ex(('127.0.0.1',port))!=0\n s.close()\np=pathlib.Path('/run/mikka-viewer');p.mkdir(mode=0o700,exist_ok=True)\nassert not (p/'key').exists()\nprint(json.dumps({'empty':True}))\nMIKKA_LISTENER_SETUP"
    check((await jsonCommand(sandbox, setup)).empty === true, 'scope')
    for (const name of ['viewer-gateway.py', 'subagent-gateway.py']) {
      const handle = await sandbox.commands.run(`exec python3 '/opt/mikka/worker/scripts/e2b/${name}'`, {
        user: 'root', background: true, timeoutMs: 0,
        envs: { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/opt/mikka/runtime/preview-python-3.14.0' },
        onStdout: () => {}, onStderr: () => {},
      })
      handles.push(handle)
      void handle.wait().catch(() => {})
    }
    const ready = await jsonCommand(sandbox, "python3 - <<'MIKKA_LISTENER_READY'\nimport json,socket,time\nfor port in (6080,6082):\n for attempt in range(50):\n  s=socket.socket();s.settimeout(.1);ok=s.connect_ex(('127.0.0.1',port))==0;s.close()\n  if ok:break\n  time.sleep(.1)\n else:raise RuntimeError('listener_not_ready')\nprint(json.dumps({'ready':True}))\nMIKKA_LISTENER_READY", 15_000)
    check(ready.ready === true, 'ready')
    const viewer = await request(publicOrigin(sandbox, 6080) + '/vnc', fetchImpl)
    check(viewer.status === 401, 'authentication'); await viewer.body?.cancel()
    const subagent = await request(publicOrigin(sandbox, 6082) + '/version', fetchImpl)
    const version = await subagent.text()
    const loadedVersion = hash(Buffer.concat(await Promise.all(['subagent-gateway.py', 'subagent-cdp.mjs']
      .map(name => readFile(new URL(name, import.meta.url))))))
    check(subagent.status === 200 && version === loadedVersion, 'http')
    const refused = await request(publicOrigin(sandbox, 6082) + '/agents/' + randomUUID() + '/state', fetchImpl)
    check(refused.status === 401, 'authentication'); await refused.body?.cancel()
    return { viewerUnauthenticatedStatus: 401, subagentVersionStatus: 200, subagentVersion: version,
      subagentUnauthenticatedStatus: 401, realEntrypoints: true, browserFramesTested: false }
  } finally { for (const handle of handles) await handle.kill().catch(() => {}) }
}

async function jsonCommand(sandbox, command, timeoutMs = 25_000, user = 'root') {
  try {
    const result = await sandbox.commands.run(command, { user, timeoutMs })
    check(result.exitCode === 0 && Buffer.byteLength(result.stdout) <= 32_768, 'process')
    return JSON.parse(result.stdout)
  } catch (cause) { throw error('process', cause) }
}

async function localMarker(sandbox, port) {
  check(Number.isInteger(port) && port > 1024 && port < 65536, 'ports')
  const reply = await jsonCommand(sandbox, `python3 - <<'MIKKA_REPLACEMENT_POSITIVE'\nimport json,urllib.request\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nr=opener.open('http://127.0.0.1:${port}/',timeout=5)\nprint(json.dumps({'status':r.status,'markerMatched':r.read()==${JSON.stringify(MARKER)}.encode()}))\nMIKKA_REPLACEMENT_POSITIVE`, 10_000, 'user')
  check(reply.status === 200 && reply.markerMatched === true, 'positive_control')
  return reply
}

async function readGuard(sandbox, digest, before) {
  // This is deliberately read-only. Neither this probe nor a preview GET may
  // install a rule/receipt after the anonymous worker has already started.
  const source = `import pathlib,subprocess\npid=int(pathlib.Path('/home/user/.mikka/preloaded.pid').read_text())\nr=subprocess.run(['python3','${GUARD}','ready',str(pid)],capture_output=True,text=True,check=True)\nprint(r.stdout,end='')`
  return guardReceipt(await jsonCommand(sandbox, `python3 - <<'MIKKA_READ_INGRESS'\n${source}\nMIKKA_READ_INGRESS`), digest, before)
}

async function control(sandbox, message) {
  const path = `/run/mikka-preview/acceptance-${randomUUID()}.json`
  await sandbox.files.write(path, JSON.stringify(message), { user: 'root' })
  try {
    return await jsonCommand(sandbox, `chmod 600 '${path}' && python3 '${GATEWAY}' control '${path}'`)
  } finally {
    await sandbox.commands.run(`rm -f -- '${path}'`, { user: 'root', timeoutMs: 5000 }).catch(() => {})
  }
}

export async function prepareFrameworkPreview(sandbox, binding, port, report) {
  const prepared = await control(sandbox, { operation: 'prepare', binding, port })
  if (!(prepared.running === true && prepared.port === port)) {
    // The Unix reply is not a receipt. Preserve only fixed classifications,
    // bounded counts and timings; never copy its addresses or process data.
    const diagnostic = prepared.diagnostic
    const probes = Array.isArray(diagnostic?.probes) ? diagnostic.probes : []
    const controlError = typeof prepared.error === 'string'
    report.previewDiagnostic = {
      reply: controlError ? 'control_error' : prepared.running === true ? 'port_mismatch'
        : prepared.running === false && prepared.state === 'unavailable' && prepared.code === 'no_loopback_server' ? 'unavailable' : 'invalid_reply',
      error: controlError ? PREVIEW_ERRORS.has(prepared.error) ? prepared.error : 'other' : null,
      status: controlError && [400, 403, 404, 409, 429, 503].includes(prepared.status) ? prepared.status : null,
      candidateCount: diagnosticInteger(diagnostic?.candidateCount, 0, 16),
      vanishedFds: diagnosticInteger(diagnostic?.vanishedFds, 0, 4096 * 1024),
      processReadErrors: diagnosticInteger(diagnostic?.processReadErrors, 0, 4096),
      budgetExpired: typeof diagnostic?.budgetExpired === 'boolean' ? diagnostic.budgetExpired : null,
      probes: probes.slice(0, 16).map(row => ({
        outcome: PREVIEW_PROBE_OUTCOMES.has(row?.outcome) ? row.outcome : 'other',
        elapsedMs: diagnosticInteger(row?.elapsedMs, 0, 25_000),
      })), truncated: probes.length > 16,
    }
  }
  check(prepared.running === true && prepared.port === port, 'preview')
  return prepared
}

async function background(sandbox, command, options, ready, timeoutMs = 30_000) {
  const pending = Promise.withResolvers()
  let buffer = '', settled = false
  const handle = await sandbox.commands.run(command, { ...options, background: true, timeoutMs: 0,
    onStderr: () => {}, onStdout: chunk => {
      if (settled) return
      buffer += chunk
      if (buffer.length > 65_536) { settled = true; pending.reject(error('ready')); return }
      try {
        const value = ready(buffer)
        if (value !== undefined) { settled = true; pending.resolve(value) }
      } catch (cause) { settled = true; pending.reject(error('ready', cause)) }
    } })
  void handle.wait().then(() => { if (!settled) pending.reject(error('ready')) }, () => { if (!settled) pending.reject(error('ready')) })
  return { handle, value: await bounded(pending.promise, timeoutMs, 'ready') }
}

export async function startFrameworkServer(sandbox, kind, directory, root, port) {
  check(['next', 'vite'].includes(kind), 'configuration')
  validPorts({ framework: port }, ['framework'])
  const deadline = Date.now() + 90_000, banner = Promise.withResolvers()
  void banner.promise.catch(() => {})
  let handle, abandoned = false, settled = false, buffer = ''
  const stop = async owned => { try { await bounded(owned.kill(), 5000, 'cleanup') } catch {} }
  const remaining = () => {
    const milliseconds = Math.min(90_000, Math.floor(deadline - Date.now()))
    check(milliseconds > 0, 'ready')
    return milliseconds
  }
  const binary = kind === 'next' ? `${root}/node_modules/next/dist/bin/next` : `${root}/node_modules/vite/bin/vite.js`
  const args = kind === 'next' ? `dev --webpack --hostname 127.0.0.1 --port ${port}` : `--host 127.0.0.1 --port ${port} --strictPort`
  const startup = (async () => {
    handle = await sandbox.commands.run(`exec '${NODE}' '${binary}' ${args}`, {
      user: 'user', cwd: directory, envs: { NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
      background: true, timeoutMs: 0, onStderr: () => {}, onStdout: chunk => {
        if (settled || abandoned) return
        buffer += chunk
        if (buffer.length > 65_536) { settled = true; banner.reject(error('ready')); return }
        if (kind === 'next' ? buffer.includes('Ready in') : buffer.includes('Local:')) {
          settled = true; banner.resolve()
        }
      },
    })
    // A timed-out SDK start can still deliver its exact process handle later.
    if (abandoned) { await stop(handle); throw error('ready') }
    void handle.wait().then(() => { if (!settled) banner.reject(error('ready')) },
      cause => { if (!settled) banner.reject(error('ready', cause)) })
    await banner.promise
    check(!abandoned, 'ready')
    const milliseconds = remaining()
    // Next's banner precedes handler initialization. One local request and the
    // banner share the original startup deadline; this grants no public lease.
    const request = `import http.client,json\nc=http.client.HTTPConnection('127.0.0.1',${port},timeout=${milliseconds}/1000)\ntry:\n c.request('GET','/',headers={'Host':'localhost:${port}','Accept-Encoding':'identity','Connection':'close'})\n r=c.getresponse();b=r.read(1048577)\n print(json.dumps({'status':r.status,'markerMatched':len(b)<=1048576 and b'<main>mikka-preview-${kind}-v1</main>' in b}))\nfinally:c.close()`
    const reply = await jsonCommand(sandbox, `python3 - <<'MIKKA_FRAMEWORK_HTTP_READY'\n${request}\nMIKKA_FRAMEWORK_HTTP_READY`, milliseconds, 'user')
    check(!abandoned && remaining() > 0 && reply.status === 200 && reply.markerMatched === true, 'ready')
    return { handle, value: true }
  })()
  void startup.catch(() => {})
  try { return await bounded(startup, remaining(), 'ready') }
  catch (cause) {
    abandoned = true
    if (handle) await stop(handle)
    throw cause
  }
}

async function rawChecks(sandbox, ports, fetchImpl) {
  const local = await jsonCommand(sandbox, `python3 - <<'MIKKA_LOCAL_POSITIVE'\nimport json,urllib.request\nports=${JSON.stringify(ports)}\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nresult={}\nfor name in ${JSON.stringify(RAW_NAMES)}:\n host='[::1]' if name=='userLoopback6' else '127.0.0.1'\n result[name]=opener.open('http://'+host+':'+str(ports[name]),timeout=5).read()==${JSON.stringify(MARKER)}.encode()\nprint(json.dumps(result))\nMIKKA_LOCAL_POSITIVE`, 20_000, 'user')
  check(RAW_NAMES.every(name => local[name] === true), 'positive_control')
  const results = await Promise.all([...RAW_NAMES, 'rootMarked'].map(async name => [name, await markerSample(publicOrigin(sandbox, ports[name]), fetchImpl)]))
  const external = Object.fromEntries(results)
  check(external.rootMarked.status === 200 && external.rootMarked.markerMatched, 'positive_control')
  check(RAW_NAMES.every(name => denied(external[name])), 'raw_exposed')
  return { local, external }
}

export function observeHmr(url, protocols, headers, Socket) {
  const socket = new Socket(url, protocols, { headers, handshakeTimeout: 10_000, followRedirects: false, maxPayload: 1024 * 1024 })
  const opened = Promise.withResolvers(), initial = Promise.withResolvers(), updated = Promise.withResolvers(), closed = Promise.withResolvers()
  const failed = Promise.withResolvers()
  void failed.promise.catch(() => {})
  let armed = false, requestedClose = false, messages = 0, bytes = 0, closeCode = null, transportFailed = false, alreadyClosed = false
  const fail = () => { transportFailed = true; failed.reject(error('hmr')) }
  socket.on('open', () => opened.resolve())
  socket.on('error', fail)
  socket.on('message', (data, binary) => {
    messages++; bytes += data.length
    if (messages > 200 || bytes > 8 * 1024 * 1024) { fail(); return }
    if (binary) return
    let value
    try { value = JSON.parse(data.toString()) } catch { fail(); return }
    initial.resolve()
    if (armed && ['built', 'serverComponentChanges', 'update', 'full-reload'].includes(value.type)) updated.resolve(value.type)
  })
  socket.on('close', code => { alreadyClosed = true; closeCode = code; closed.resolve(); if (!requestedClose) fail() })
  const wait = (promise, ms = 25_000) => bounded(Promise.race([promise, failed.promise]), ms, 'hmr')
  return {
    async ready() { await wait(opened.promise, 10_000); await wait(initial.promise, 10_000) },
    arm(next) { armed = true; if (next) socket.send(JSON.stringify({ event: 'ping', page: '/' })) },
    updated: () => wait(updated.promise),
    expectRevoke() {
      check(socket.readyState === Socket.OPEN && !alreadyClosed && !transportFailed, 'revoke')
      requestedClose = true
    },
    async revoked() { await bounded(closed.promise, 5000, 'revoke'); return { messages, bytes, closeCode, closed: true } },
    close() { requestedClose = true; socket.terminate() },
  }
}

async function framework(sandbox, kind, root, identity, fetchImpl, Socket, runtimeReport) {
  const directory = `${root}/${kind}`
  const files = kind === 'next' ? {
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.jsx': 'export default function Page(){return <main>mikka-preview-next-v1</main>}',
  } : { 'index.html': '<main>mikka-preview-vite-v1</main><script type="module" src="/main.js"></script>',
    'main.js': 'export const version = 1; if (import.meta.hot) import.meta.hot.accept();' }
  await sandbox.commands.run(`install -d -m 700 -o user -g user '${directory}' '${directory}/app'`, { user: 'root', timeoutMs: 5000 })
  for (const [name, value] of Object.entries(files)) await sandbox.files.write(`${directory}/${name}`, value, { user: 'user' })
  await sandbox.files.write(`${directory}/package.json`, JSON.stringify({ name: `mikka-preview-${kind}`, private: true }), { user: 'user' })
  const port = await jsonCommand(sandbox, "python3 -c 'import socket,json;s=socket.socket();s.bind((\"127.0.0.1\",0));print(json.dumps(s.getsockname()[1]));s.close()'", 5000, 'user')
  validPorts({ framework: port }, ['framework'])
  const running = await startFrameworkServer(sandbox, kind, directory, root, port)
  const runId = randomUUID(), leaseId = randomUUID()
  const binding = { taskId: randomUUID(), runId, ownerId: identity.fixtureId, workspaceId: randomUUID(),
    deviceId: randomUUID(), repoId: randomUUID(), sandboxId: sandbox.sandboxId, epoch: 1,
    worktreePath: directory, expiresAt: Date.now() / 1000 + 240 }
  let observer, gatewayPort
  const report = { framework: kind, rawDenied: false, authenticatedHttp: false, assets: false, hotReload: false,
    unauthenticatedStatus: null, replayStatus: null, revoked: false, takeoverDenied: false }
  try {
    const raw = await markerSample(publicOrigin(sandbox, port), fetchImpl)
    check(denied(raw), 'raw_exposed'); report.rawDenied = true
    const prepared = await prepareFrameworkPreview(sandbox, binding, port, runtimeReport)
    gatewayPort = prepared.gatewayPort
    const origin = publicOrigin(sandbox, gatewayPort)
    const unauthenticated = await request(origin + '/', fetchImpl)
    report.unauthenticatedStatus = unauthenticated.status
    await unauthenticated.body?.cancel()
    check([401, 403].includes(unauthenticated.status), 'authentication')
    const issued = await control(sandbox, { operation: 'issue', binding, gatewayPort, origin,
      parentOrigin: 'https://mikka-acceptance.example.invalid', leaseId })
    check(typeof issued.ticket === 'string' && issued.ticket.length <= 4096, 'authentication')
    const entryPath = '/__mikka/preview/open?ticket=' + encodeURIComponent(issued.ticket)
    const entry = await bootstrapRequest(origin + entryPath)
    const setCookie = entry.headers.get('set-cookie') ?? ''
    const csp = entry.headers.get('content-security-policy') ?? '', bootstrap = await entry.text()
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1]
    check(entry.status === 200 && setCookie.startsWith('__Host-mikka_preview=')
      && /;\s*Secure(?:;|$)/i.test(setCookie) && /;\s*HttpOnly(?:;|$)/i.test(setCookie)
      && /;\s*SameSite=None(?:;|$)/i.test(setCookie) && /;\s*Partitioned(?:;|$)/i.test(setCookie)
      && nonce && csp.includes("default-src 'none'") && csp.includes('frame-ancestors https://mikka-acceptance.example.invalid')
      && entry.headers.get('referrer-policy') === 'no-referrer' && entry.headers.get('content-type')?.startsWith('text/html')
      && bootstrap.includes(`<script nonce="${nonce}">`) && bootstrap.includes('history.replaceState(null,"","/")')
      && bootstrap.includes('location.replace("/")'), 'authentication')
    report.crossSiteBootstrap = true
    const headers = { Cookie: setCookie.split(';')[0], Origin: origin, 'Sec-Fetch-Site': 'same-origin' }
    const replay = await request(origin + entryPath, fetchImpl)
    report.replayStatus = replay.status; await replay.body?.cancel()
    check([401, 403].includes(replay.status), 'authentication')
    const page = await request(origin + '/', fetchImpl, { headers })
    const html = await page.text()
    check(page.status === 200 && html.includes(`mikka-preview-${kind}-v1`), 'http')
    report.authenticatedHttp = true
    let path, protocols = []
    if (kind === 'next') {
      const asset = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
      const document = /self\.__next_r="([^"]+)"/.exec(html)?.[1]
      check(asset?.startsWith('/') && document && document.length < 256, 'http')
      const response = await request(origin + asset, fetchImpl, { headers })
      check(response.status === 200 && (await response.arrayBuffer()).byteLength > 100, 'http')
      path = '/_next/hmr?id=' + encodeURIComponent(document)
    } else {
      const response = await request(origin + '/@vite/client', fetchImpl, { headers })
      const text = await response.text(), token = /const wsToken = ['"]([^'"]+)['"]/.exec(text)?.[1]
      check(response.status === 200 && token && token.length < 256, 'http')
      const module = await request(origin + '/main.js', fetchImpl, { headers })
      check(module.status === 200 && (await module.text()).includes('import.meta.hot'), 'http')
      path = '/?token=' + encodeURIComponent(token); protocols = ['vite-hmr']
    }
    report.assets = true
    observer = observeHmr(origin.replace('https:', 'wss:') + path, protocols, headers, Socket)
    await observer.ready(); observer.arm(kind === 'next')
    const changed = kind === 'next' ? 'app/page.jsx' : 'main.js'
    await sandbox.files.write(`${directory}/${changed}`, files[changed].replace('v1', 'v2').replace('version = 1', 'version = 2'), { user: 'user' })
    report.hmrEvent = await observer.updated()
    const updated = await request(origin + (kind === 'next' ? '/' : '/main.js'), fetchImpl, { headers })
    check(updated.status === 200 && (await updated.text()).includes(kind === 'next' ? 'mikka-preview-next-v2' : 'version = 2'), 'hmr')
    report.hotReload = true
    observer.expectRevoke()
    const revoked = await control(sandbox, { operation: 'revoke', runId, leaseIds: [leaseId] })
    check(revoked.revoked === true, 'revoke')
    report.websocket = await observer.revoked()
    report.revoked = true
    check(denied(await markerSample(origin, fetchImpl)), 'revoke')
    const replacement = await background(sandbox,
      `exec python3 '/opt/mikka/acceptance-${identity.fixtureId}/servers.py' --user --replacement-port ${gatewayPort}`,
      { user: 'user' }, text => text.includes('\n') ? JSON.parse(text.split('\n')[0]) : undefined)
    check(replacement.value?.ports?.replacement === gatewayPort, 'takeover_bind')
    try {
      report.takeoverLocal = await localMarker(sandbox, gatewayPort)
      check(denied(await markerSample(origin, fetchImpl)), 'takeover_not_denied'); report.takeoverDenied = true
    }
    finally { await replacement.handle.kill().catch(() => {}) }
    return report
  } finally {
    observer?.close()
    await control(sandbox, { operation: 'revoke', runId }).catch(() => {})
    await running.handle.kill().catch(() => {})
  }
}

export async function probeTerminalAfterPreview(sandbox, report, identity, terminalProbe, fetchImpl) {
  report.stage = 'preview_shutdown'
  report.previewStopped = (await control(sandbox, { operation: 'shutdown' }))?.stopped === true
  check(report.previewStopped, 'process')
  report.stage = 'terminal'
  report.terminal = await terminalProbe(sandbox, { sourceCommit: identity.sourceCommit, fixtureId: identity.fixtureId, fetchImpl })
  check(report.terminal?.passed === true, 'terminal')
}

export async function probeWorkspaceIngress(initialSandbox, identity, {
  fetchImpl = fetch, Socket = require('next/dist/compiled/ws'),
  terminalProbe = async (...args) => (await import('./workspace-terminal-acceptance.mjs')).probeWorkspaceTerminal(...args),
} = {}) {
  let sandbox = initialSandbox
  let identityOperation = 'get_info'
  check(SHA.test(identity.sourceCommit) && SHA.test(identity.workerSha) && UUID.test(identity.fixtureId), 'configuration')
  const source = await readFile(new URL('../../packages/daemon/scripts/workspace-ingress.py', import.meta.url))
  const expectedDigest = hash(source)
  const report = { version: 1, sourceCommit: identity.sourceCommit, workerSha: identity.workerSha,
    fixtureId: identity.fixtureId, templateId: identity.templateId, sandboxId: sandbox.sandboxId,
    scope: 'private_derived_candidate_prelistener_preview_terminal_and_full_memory_resume',
    productionTaskAuthorityTested: false, subscriptionsTested: false, agentRootIsolationProven: false,
    stage: 'identity', startedAt: new Date().toISOString(), frameworks: [], passed: false }
  try {
    const info = await sandbox.getInfo()
    check(info.templateId === identity.templateId && info.metadata?.sourceCommit === identity.sourceCommit
      && info.metadata?.fixtureId === identity.fixtureId && info.metadata?.application === PURPOSE, 'scope')
    identityOperation = 'source_command'
    const sourceResult = await sandbox.commands.run("git -C /opt/mikka/worker rev-parse HEAD && cat /opt/mikka/worker-source-sha", { user: 'root', timeoutMs: 5000 })
    identityOperation = 'source_compare'
    const actualSource = sourceResult.stdout.trim().split('\n')
    check(actualSource.length === 2 && actualSource[0] === identity.sourceCommit && actualSource[1] === identity.workerSha, 'source')
    report.stage = 'prelistener_guard'
    report.guard = await readGuard(sandbox, expectedDigest)
    const fixtureRoot = `/opt/mikka/acceptance-${identity.fixtureId}`
    const appRoot = `/home/user/mikka-preview-${identity.fixtureId}`
    await sandbox.commands.run(`install -d -m 755 '${fixtureRoot}'; install -d -m 700 -o user -g user '${appRoot}'`, { user: 'root', timeoutMs: 5000 })
    await sandbox.files.write(`${fixtureRoot}/servers.py`, await readFile(new URL('./workspace-ingress-servers.py', import.meta.url), 'utf8'), { user: 'root' })
    const listeners = await background(sandbox, `exec python3 '${fixtureRoot}/servers.py'`, { user: 'root' },
      text => text.includes('\n') ? JSON.parse(text.split('\n')[0]) : undefined)
    const ports = validPorts(listeners.value?.ports)
    // A bounded fixture setup allowance for envd's loopback forwarding scan.
    await delay(1500)
    report.stage = 'initial_ingress'
    report.initialIngress = await rawChecks(sandbox, ports, fetchImpl)
    if (!report.guard.providerPorts.includes(50005)) {
      const unused = await background(sandbox, `exec python3 '${fixtureRoot}/servers.py' --user --replacement-port 50005`,
        { user: 'user' }, text => text.includes('\n') ? JSON.parse(text.split('\n')[0]) : undefined)
      try {
        check(unused.value?.ports?.replacement === 50005, 'ports')
        report.unassignedProviderPortLocal = await localMarker(sandbox, 50005)
        report.unassignedProviderPort = await markerSample(publicOrigin(sandbox, 50005), fetchImpl)
        check(denied(report.unassignedProviderPort), 'raw_exposed')
      } finally { await unused.handle.kill().catch(() => {}) }
    } else report.unassignedProviderPort = { exercised: false, reason: 'actual_root_provider_listener_present' }
    report.stage = 'gateway_listener_wiring'
    report.listenerWiring = await listenerWiring(sandbox, fetchImpl)
    const rootOrigin = publicOrigin(sandbox, ports.rootMarked)
    report.outbound = await jsonCommand(sandbox, `python3 - <<'MIKKA_USER_OUTBOUND'\nimport json,urllib.request\nr=urllib.request.urlopen(${JSON.stringify(rootOrigin)},timeout=15)\nprint(json.dumps({'status':r.status,'markerMatched':r.read()==${JSON.stringify(MARKER)}.encode()}))\nMIKKA_USER_OUTBOUND`, 20_000, 'user')
    check(report.outbound.status === 200 && report.outbound.markerMatched, 'outbound')
    report.stage = 'framework_dependencies'
    for (const file of ['package.json', 'package-lock.json']) await sandbox.files.write(`${appRoot}/${file}`,
      await readFile(new URL(`./fixtures/preview-frameworks/${file}`, import.meta.url), 'utf8'), { user: 'user' })
    const installation = await sandbox.commands.run(`'${NODE}' /opt/mikka/runtime/node/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund`,
      { user: 'user', cwd: appRoot, timeoutMs: 180_000, envs: { NEXT_TELEMETRY_DISABLED: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false' } })
    check(installation.exitCode === 0, 'dependencies')
    const versions = await jsonCommand(sandbox,
      `'${NODE}' -e 'console.log(JSON.stringify(Object.fromEntries(["next","vite","react","react-dom"].map(p=>[p,require("${appRoot}/node_modules/"+p+"/package.json").version]))))'`, 5000, 'user')
    check(versions.next === '16.4.1' && versions.vite === '8.3.6' && versions.react === '19.3.1' && versions['react-dom'] === '19.3.1', 'dependencies')
    report.frameworkVersions = versions
    report.frameworkLockSha256 = hash(await readFile(new URL('./fixtures/preview-frameworks/package-lock.json', import.meta.url)))
    await jsonCommand(sandbox, `python3 '${GATEWAY}' ensure`)
    for (const kind of ['next', 'vite']) { report.stage = kind; report.frameworks.push(await framework(sandbox, kind, appRoot, identity, fetchImpl, Socket, report)) }
    await probeTerminalAfterPreview(sandbox, report, identity, terminalProbe, fetchImpl)
    report.stage = 'pause_resume'
    check(await sandbox.pause({ mode: 'full' }) === true, 'resume')
    sandbox = await sandbox.connect({ timeoutMs: 480_000 })
    const resumed = await sandbox.getInfo()
    check(resumed.sandboxId === report.sandboxId && resumed.templateId === identity.templateId
      && resumed.metadata?.fixtureId === identity.fixtureId, 'resume')
    report.resumedGuard = await readGuard(sandbox, expectedDigest, report.guard)
    report.resumedIngress = await rawChecks(sandbox, ports, fetchImpl)
    report.stage = 'completed'; report.passed = true
  } catch (cause) {
    report.failure = safeFailure(cause)
    if (report.stage === 'identity') report.identityDiagnostic = identityDiagnostic(cause, identityOperation)
  } finally { report.finishedAt = new Date().toISOString() }
  return report
}

const metadata = journal => ({ application: PURPOSE, issue: '1724', sourceCommit: journal.sourceCommit,
  workerSha: journal.workerSha, fixtureId: journal.fixtureId, opsSource: journal.opsSource,
  runId: journal.runId, runAttempt: journal.runAttempt, kind: journal.kind })

export function validateJournal(value, sourceCommit, opsSource, execution) {
  check(value?.version === 1 && value.purpose === PURPOSE && SHA.test(sourceCommit) && SHA.test(opsSource)
    && value.sourceCommit === sourceCommit && value.opsSource === opsSource && SHA.test(value.workerSha ?? '')
    && UUID.test(value.fixtureId ?? '') && ['claude', 'codex'].includes(value.kind)
    && ID.test(value.templateId ?? '') && /^[1-9][0-9]*$/.test(value.runId ?? '')
    && /^[1-9][0-9]*$/.test(value.runAttempt ?? '') && typeof value.creationRequested === 'boolean'
    && value.runId === execution?.runId && value.runAttempt === execution?.runAttempt
    && (value.sandboxId === null || ID.test(value.sandboxId ?? ''))
    && (value.creationRequested || value.sandboxId === null), 'journal')
  return value
}

/** Static provider reads and exact metadata only; cleanup cannot resume a VM. */
export async function cleanupOwnedRuntime(journal, sourceCommit, opsSource, sdk, apiOptions, execution) {
  validateJournal(journal, sourceCommit, opsSource, execution)
  if (!journal.creationRequested) return { stopped: true, absent: true, outcome: 'creation_not_requested' }
  const { Sandbox, SandboxNotFoundError } = sdk
  const expected = metadata(journal)
  let id = journal.sandboxId
  if (!id) {
    const pages = Sandbox.list({ ...apiOptions, query: { metadata: expected, state: ['running', 'paused'] }, limit: 2 })
    const rows = await pages.nextItems()
    check(!pages.hasNext && rows.length <= 1, 'cleanup')
    if (!rows.length) return { stopped: false, absent: false, outcome: 'creation_unconfirmed' }
    id = rows[0].sandboxId
    check(ID.test(id ?? ''), 'cleanup')
  }
  let info
  try { info = await Sandbox.getInfo(id, apiOptions) }
  catch (cause) {
    if (SandboxNotFoundError && cause instanceof SandboxNotFoundError)
      return { stopped: true, absent: true, outcome: 'provider_already_absent' }
    throw error('cleanup', cause)
  }
  check(info.sandboxId === id && info.templateId === journal.templateId
    && Object.entries(expected).every(([key, value]) => info.metadata?.[key] === value), 'cleanup')
  const acknowledged = await Sandbox.kill(id, apiOptions)
  try { await Sandbox.getInfo(id, apiOptions) }
  catch (cause) {
    if (SandboxNotFoundError && cause instanceof SandboxNotFoundError)
      return { stopped: true, absent: true, scopeVerified: true, killAcknowledged: acknowledged === true,
        outcome: acknowledged ? 'provider_kill_acknowledged_and_absent' : 'provider_already_absent' }
    throw error('cleanup', cause)
  }
  return { stopped: false, absent: false, scopeVerified: true, killAcknowledged: acknowledged === true,
    outcome: 'provider_absence_not_confirmed' }
}

export function candidateIdentity(report, sourceCommit) {
  check(report?.sourceCommit === sourceCommit && SHA.test(sourceCommit) && SHA.test(report.workerSha ?? '')
    && report.templates && Object.keys(report.templates).length === 2, 'candidate')
  const ids = new Set()
  for (const kind of ['claude', 'codex']) {
    const row = report.templates[kind], proof = row?.conservation
    check(row?.baseTemplate === kind && row.preinstalled === true && row.privateVerified === true
      && ID.test(row.templateId ?? '') && ID.test(row.buildId ?? '') && !ids.has(row.templateId)
      && Number.isSafeInteger(proof?.before?.entries) && proof.before.entries > 0 && DIGEST.test(proof.before.sha256 ?? '')
      && JSON.stringify(proof.before) === JSON.stringify(proof.after), 'candidate')
    ids.add(row.templateId)
  }
  return report
}

async function main(args) {
  check(args.length === 4 && ['--candidates', '--cleanup'].includes(args[0]) && args[2] === '--output', 'configuration')
  const [operation, input, , output] = args
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
  const opsSource = process.env.GITHUB_SHA
  check(SHA.test(sourceCommit) && SHA.test(opsSource ?? '') && process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && process.env.GITHUB_REF === 'refs/heads/ops/self-hosted-vault-closeout-20261108'
    && process.env.GITHUB_ACTOR === 'alexj11324' && process.env.E2B_API_KEY, 'configuration')
  const sdk = await import('e2b')
  const execution = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }
  const apiOptions = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
  const reports = []
  if (operation === '--cleanup') {
    for (const kind of ['claude', 'codex']) {
      const path = resolve(input, `${kind}.cleanup.json`)
      let journal
      try {
        const stat = await lstat(path)
        check(stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096, 'journal')
        journal = JSON.parse(await readFile(path, 'utf8'))
      } catch (cause) {
        if (cause?.code === 'ENOENT') { reports.push({ kind, stopped: true, absent: true, outcome: 'no_creation_journal' }); continue }
        throw error('journal', cause)
      }
      try { reports.push({ kind, ...await cleanupOwnedRuntime(journal, sourceCommit, opsSource, sdk, apiOptions, execution) }) }
      catch { reports.push({ kind, stopped: false, absent: false, outcome: 'cleanup_failed' }) }
    }
    await atomic(output, { version: 1, sourceCommit, opsSource, cleanup: reports })
    check(reports.every(row => row.stopped && row.absent), 'cleanup')
    return
  }
  const candidates = candidateIdentity(JSON.parse(await readFile(input, 'utf8')), sourceCommit)
  for (const kind of ['claude', 'codex']) {
    const row = candidates.templates[kind]
    const journal = validateJournal({ version: 1, purpose: PURPOSE, sourceCommit, opsSource,
      workerSha: candidates.workerSha, fixtureId: randomUUID(), templateId: row.templateId, kind,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      creationRequested: false, sandboxId: null }, sourceCommit, opsSource, execution)
    const path = resolve(output, `${kind}.cleanup.json`)
    await atomic(path, journal, true)
    let report = { version: 1, sourceCommit, workerSha: journal.workerSha, fixtureId: journal.fixtureId,
      templateId: row.templateId, kind, stage: 'create', passed: false }
    try {
      journal.creationRequested = true; await atomic(path, journal)
      const sandbox = await sdk.Sandbox.create(row.templateId, { ...apiOptions, timeoutMs: 480_000,
        network: { allowPublicTraffic: true }, lifecycle: { onTimeout: 'kill', autoResume: false }, metadata: metadata(journal) })
      check(ID.test(sandbox.sandboxId ?? ''), 'scope')
      journal.sandboxId = sandbox.sandboxId; await atomic(path, journal)
      report = { ...await probeWorkspaceIngress(sandbox, journal), kind }
    } catch (cause) { report.failure = safeFailure(cause) }
    finally {
      try { report.cleanup = await cleanupOwnedRuntime(journal, sourceCommit, opsSource, sdk, apiOptions, execution) }
      catch { report.cleanup = { stopped: false, absent: false, outcome: 'cleanup_failed' } }
      await atomic(resolve(output, `${kind}.json`), report)
      reports.push(report)
    }
    // The paths are independent. A failed case does not prevent the other
    // harness, but unknown resource cleanup always stops another allocation.
    if (!report.cleanup.stopped || !report.cleanup.absent) break
  }
  const passed = reports.length === 2 && reports.every(row => row.passed && row.cleanup.stopped && row.cleanup.absent)
  await atomic(resolve(output, 'summary.json'), { version: 1, sourceCommit, opsSource, workerSha: candidates.workerSha,
    passed, cases: reports.map(row => ({ kind: row.kind, passed: row.passed, stage: row.stage, failure: row.failure,
      sandboxId: row.sandboxId, cleanup: row.cleanup })) })
  check(passed, 'internal')
  console.log(JSON.stringify({ sourceCommit, workerSha: candidates.workerSha, passed }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('workspace_ingress_acceptance_failed'); process.exitCode = 1 })
}
