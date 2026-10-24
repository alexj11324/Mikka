// Actual Next/Mikka route acceptance, isolated databases and synthetic external TLS vault/website.
// This does NOT satisfy real Infisical, real account, UI screenshot or deployed acceptance gates.
import { Pool } from 'pg'
import { createServer } from 'node:http'
import { createServer as createTLS } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, symlink, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = fileURLToPath(new URL('../', import.meta.url))
const supplied = process.env.CREDENTIAL_TEST_ADMIN_DATABASE_URL
if (!supplied) throw new Error('An isolated loopback CREDENTIAL_TEST_ADMIN_DATABASE_URL is required')
const adminURL = new URL(supplied)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminURL.hostname) || adminURL.pathname !== '/postgres') throw new Error('Loopback /postgres only')
const directory = await mkdtemp(join(tmpdir(), 'mikka-system-credential-'))
const nativeCache = await mkdtemp(join(root, '../.cache/mik79-swc-'))
const appDirectory = join(directory, 'app'); await mkdir(appDirectory)
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
execFileSync('git', ['archive', '--output', join(directory, 'source.tar'), 'HEAD'], { cwd: root })
execFileSync('tar', ['-xf', join(directory, 'source.tar'), '-C', appDirectory])
const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
for (const path of tracked) if (path.split('/').some(part => part.startsWith('.env'))) await rm(join(appDirectory, path), { force: true })
const changed = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
for (const path of changed) {
  if (path.split('/').some(part => part === '..' || part === '.git' || part.startsWith('.env'))) throw new Error('Unsafe source snapshot path')
  await mkdir(dirname(join(appDirectory, path)), { recursive: true }); await copyFile(join(root, path), join(appDirectory, path))
}
await symlink(join(root, 'node_modules'), join(appDirectory, 'node_modules'))
const suffix = randomUUID().replaceAll('-', '')
const names = [`mikka_credential_test_system_app_${suffix}`, `mikka_credential_test_system_workspace_${suffix}`]
const urls = names.map(name => { const url = new URL(supplied); url.pathname = `/${name}`; return url.href })
const poolLimits = { connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 }
const admin = new Pool({ connectionString: supplied, max: 1, ...poolLimits }), created = []
const app = new Pool({ connectionString: urls[0], ...poolLimits }), workspace = new Pool({ connectionString: urls[1], ...poolLimits })
const secret = `fixture-${randomBytes(30).toString('hex')}`, vaultToken = randomBytes(24).toString('hex')
const websiteCookie = randomBytes(24).toString('hex'), vaultValues = new Map(), evidence = []
const secretMarkers = new Set([secret, vaultToken, websiteCookie])
let next, logs = '', vaultReads = 0, vaultWrites = 0, vaultDeletes = 0
let harness, harnessOutput = '', closeHarnessBridge
const website = createServer(async (req, res) => {
  res.setHeader('content-type', 'text/html')
  if (req.url === '/login' && req.method === 'GET') return res.end('<form method="POST" action="/login"><input id="password" name="password" type="password" autocomplete="off"><button id="submit">Login</button></form>')
  if (req.url === '/login' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk
    if (new URLSearchParams(body).get('password') !== secret) { res.writeHead(403); return res.end('Rejected') }
    res.writeHead(302, { Location: '/account', 'Set-Cookie': `fixture_session=${websiteCookie}; HttpOnly; SameSite=Strict; Path=/` }); return res.end()
  }
  if (!req.headers.cookie?.includes(`fixture_session=${websiteCookie}`)) { res.writeHead(403); return res.end('Not authenticated') }
  if (req.url === '/account') return res.end('<p data-verified>ACCOUNT-42</p><a id="projects" href="/projects">Projects</a>')
  if (req.url === '/projects') return res.end('<p data-verified>Projects</p><section id="business">Project Alpine is ready for review</section>')
  res.writeHead(404); res.end('Not found')
})
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Mikka synthetic local acceptance', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt')], { stdio: 'ignore' })
const vault = createTLS({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) }, async (req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.headers.authorization !== `Bearer ${vaultToken}`) { res.writeHead(401); return res.end('{}') }
  const url = new URL(req.url, 'https://fixture'), key = url.pathname
  if (!/^\/api\/v4\/secrets\/MIKKA_CREDENTIAL_[a-f0-9]+$/.test(key)) { res.writeHead(404); return res.end('{}') }
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    if (data.projectId !== 'synthetic-system-project' || data.environment !== 'fixture' || data.secretPath !== '/credential-system-fixture') { res.writeHead(403); return res.end('{}') }
    vaultValues.set(key, data.secretValue); vaultWrites++; return res.end('{}')
  }
  if (req.method === 'GET' && vaultValues.has(key)) { vaultReads++; return res.end(JSON.stringify({ secret: { secretValue: vaultValues.get(key) } })) }
  if (req.method === 'DELETE') { vaultValues.delete(key); vaultDeletes++; return res.end('{}') }
  res.writeHead(404); res.end('{}')
})
function check(condition, message) { if (!condition) throw new Error(message) }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
async function command(args, env) {
  const child = spawn(process.execPath, args, { cwd: appDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  const [code] = await once(child, 'close'); check(code === 0, 'Local migration process failed'); return output
}
async function within(operation, milliseconds) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup deadline exceeded')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.stdin?.end(); child.kill('SIGTERM')
  try { await within(closed, 5000) }
  catch { child.kill('SIGKILL'); await within(closed, 5000) }
  check(child.exitCode !== null || child.signalCode !== null, 'Child process did not terminate')
}
try {
  for (const name of names) { await admin.query(`CREATE DATABASE "${name}"`); created.push(name) }
  const websiteOrigin = `http://127.0.0.1:${await listen(website)}`
  const vaultOrigin = `https://127.0.0.1:${await listen(vault)}`
  const reservation = createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const authSecret = randomBytes(32).toString('hex'); secretMarkers.add(authSecret)
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'development', CI: 'true', NEXT_TELEMETRY_DISABLED: '1',
    SWC_NATIVE_BINDING_CACHE: nativeCache,
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret,
    MIKKA_DATABASE_URL: urls[0], DATABASE_URL: urls[1], MIGRATE: '1',
    MIKKA_CREDENTIAL_BROKER_ENABLED: '1', MIKKA_CREDENTIAL_INGRESS_NO_BODY_CAPTURE: '1',
    MIKKA_CREDENTIAL_VAULT_ORIGIN: vaultOrigin, MIKKA_CREDENTIAL_VAULT_PROJECT_ID: 'synthetic-system-project',
    MIKKA_CREDENTIAL_VAULT_ENVIRONMENT: 'fixture', MIKKA_CREDENTIAL_VAULT_PATH: '/credential-system-fixture', MIKKA_CREDENTIAL_VAULT_TOKEN: vaultToken,
    NODE_EXTRA_CA_CERTS: join(directory, 'tls.crt'), MIKKA_CREDENTIAL_BROWSER_RUNNER: 'owned', MIKKA_CREDENTIAL_RUNTIME_KIND: 'dedicated',
    MIKKA_CREDENTIAL_BROWSER_LOOPBACK_FIXTURE: '1',
    MIKKA_CREDENTIAL_BROWSER_POLICIES: JSON.stringify([{ id: 'system-site', formURL: `${websiteOrigin}/login`, submitURL: `${websiteOrigin}/login`, successURL: `${websiteOrigin}/account`, secretSelector: '#password', submitSelector: '#submit', verifiedSelector: '[data-verified]', continuation: { accountURL: `${websiteOrigin}/account`, accountSelector: '[data-verified]', cookieName: 'fixture_session', pages: [
      { id: 'account', url: `${websiteOrigin}/account`, regions: [{ id: 'summary', selector: '[data-verified]' }], links: [{ id: 'projects', selector: '#projects', pageId: 'projects' }] },
      { id: 'projects', url: `${websiteOrigin}/projects`, regions: [{ id: 'business', selector: '#business' }] },
    ] } }]),
  }
  await writeFile(join(directory, 'migration.log'), await command(['scripts/migrate.mjs'], env))
  next = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: appDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  next.stdout.on('data', b => { logs += b }); next.stderr.on('data', b => { logs += b })
  const base = `${origin}/mikka`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try { const response = await fetch(`${base}/api/auth/get-session`, { signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); if (response.status === 200 || response.status === 401) break } catch {}
    check(next.exitCode === null, 'Actual Next app exited during startup')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  check(Date.now() < deadline, 'Actual Next startup timeout')
  async function request(path, body, cookie = '', token) {
    return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Mikka-Credential': '1', ...(cookie ? { cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  }
  for (const path of ['/api/auth/get-session', '/api/credential-requests', '/api/mcp', '/v1/devices/register', `/v1/devices/${randomUUID()}/runs/${randomUUID()}/claim`, `/v1/runs/${randomUUID()}`]) await request(path, {})
  async function signup(label) {
    const password = randomBytes(20).toString('hex'); secretMarkers.add(password)
    const response = await request('/api/auth/sign-up/email', { name: 'System fixture', email: `${label}-${suffix}@example.test`, password })
    check(response.status === 200, 'Actual Better Auth signup failed')
    const data = await response.json(), cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    for (const part of cookie.split('; ')) secretMarkers.add(part.slice(part.indexOf('=') + 1))
    check(cookie && data.user?.id, 'Actual Better Auth cookie missing'); return { id: data.user.id, cookie }
  }
  const alice = await signup('alice'), bob = await signup('bob')
  const deviceToken = `orv_${randomBytes(30).toString('hex')}`
  secretMarkers.add(deviceToken)
  await app.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), alice.id, createHash('sha256').update(deviceToken).digest('hex')])
  const registered = await request('/v1/devices/register', { name: 'System credential fixture', platform: 'linux', arch: 'x64', daemonVersion: 'fixture', protocolVersion: 1, harnesses: [] }, '', deviceToken)
  check(registered.status === 200, 'Actual device registration failed'); const { deviceId } = await registered.json()
  const workspaceId = randomUUID(), teamId = randomUUID(), taskId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), runId = randomUUID(), executionSession = randomUUID()
  await workspace.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)', [workspaceId, alice.id, 'System fixture'])
  await workspace.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,$3,$4,$5)', [workspaceId, alice.id, 'Fixture', 'fixture@example.test', 'admin'])
  await workspace.query('INSERT INTO orvilo_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [teamId, workspaceId, alice.id, 'Fixture', 'FIX'])
  await app.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,$3,$4,$5,$6)', [taskId, alice.id, 'System credential test', { type: 'doc', content: [] }, 'doing', 'normal'])
  await workspace.query('INSERT INTO orvilo_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [taskId, teamId, workspaceId, alice.id])
  await app.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agentId, alice.id, 'codex', 'System fixture', deviceId])
  await app.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [repoId, deviceId, alice.id, '/tmp/synthetic-system-repo'])
  await app.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId") VALUES ($1,$2,$3,$4,$5,$6)', [runId, alice.id, taskId, agentId, deviceId, repoId])
  const claim = await request(`/v1/devices/${deviceId}/runs/${runId}/claim`, {}, '', deviceToken)
  check(claim.status === 200, 'Actual run claim failed'); const assignment = await claim.json(); check(assignment.mcp?.token, 'Actual run-scoped MCP assignment missing')
  secretMarkers.add(assignment.mcp.token)
  const patched = await fetch(`${base}/v1/runs/${runId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'running', sessionId: executionSession }) })
  check(patched.status === 204, 'Actual execution session patch failed')
  let mcpSession, seq = 0
  async function rpc(method, params) {
    const response = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${assignment.mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(30_000) })
    check(response.ok, `Actual MCP request failed (${response.status})`)
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession
    const text = await response.text(); check(![...secretMarkers].some(value => value && text.includes(value)), 'Secret in actual MCP output')
    const payload = text.startsWith('data:') || text.includes('\ndata:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === seq) : JSON.parse(text)
    check(payload?.result && !payload.error, 'Actual MCP protocol result missing'); return payload.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mikka-credential-system-acceptance', version: '1' } })
  const initialized = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${assignment.mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) })
  check(initialized.ok, 'Actual MCP initialized notification failed'); await initialized.body?.cancel()
  const listed = await rpc('tools/list', {}); check(listed.tools.some(t => t.name === 'credential_browser_action'), 'Credential tool not registered in actual worker MCP')
  // Exercise the actual harness MCP child/config and daemon-owned transport against
  // this real Next server, without invoking a model or exposing its platform token.
  const { registerCredentialBridge, closeCredentialBridges } = await import('../packages/daemon/src/agents/credential-bridge.ts')
  const { RunContext, runPaths } = await import('../packages/daemon/src/agents/run-context.ts')
  const privateDir = join(directory, 'daemon'); await mkdir(privateDir, { mode: 0o700 })
  const paths = runPaths(join(privateDir, 'adapters'), runId); await mkdir(paths.runDir, { recursive: true, mode: 0o700 })
  await registerCredentialBridge({ privateDir, runId, mcp: assignment.mcp, isLive: () => true })
  closeHarnessBridge = () => closeCredentialBridges(privateDir)
  const spec = new RunContext({ harness: 'codex', worktree: root, privateDir, runDir: paths.runDir }).mcpServer()
  check(![...secretMarkers].some(value => value && JSON.stringify(spec).includes(value)), 'Platform credentials in actual harness config')
  harness = spawn(spec.command, spec.args, { env: { PATH: process.env.PATH, NODE_ENV: 'test', ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  harness.stderr.on('data', value => { harnessOutput += value })
  const waiting = new Map(); let harnessSequence = 0
  createInterface({ input: harness.stdout }).on('line', line => {
    harnessOutput += line + '\n'
    try { const reply = JSON.parse(line); waiting.get(reply.id)?.(reply) } catch {}
  })
  async function harnessRpc(method, params = {}) {
    const id = ++harnessSequence
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Actual harness MCP timed out')) }, 60_000)
      waiting.set(id, value => { clearTimeout(timer); waiting.delete(id); resolve(value) })
      harness.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    check(reply.result && !reply.error, 'Actual harness MCP protocol failed')
    check(![...secretMarkers].some(value => value && harnessOutput.includes(value)), 'Secret in actual harness MCP output')
    return reply.result
  }
  await harnessRpc('initialize', { protocolVersion: '2025-03-26' })
  const harnessTools = await harnessRpc('tools/list')
  check(['submit', 'ask_human', 'report_blocked', 'prepare_credential_request', 'credential_use', 'credential_browser_action'].every(name => harnessTools.tools.some(tool => tool.name === name)), 'Actual harness lost local or credential tools')
  async function call(name, args) { const result = await harnessRpc('tools/call', { name, arguments: args }); return JSON.parse(result.content[0].text) }
  const prepared = await call('prepare_credential_request', { serviceId: 'system-site', mode: 'browser_login' })
  check(prepared.runId === runId && prepared.workspaceId === workspaceId, 'Real tool context was not server bound')
  const form = await request('/api/credential-requests', prepared.submission.body, alice.cookie)
  check(form.status === 201, 'Actual credential route did not create request'); const pending = await form.json()
  check((await request(`/api/credential-requests/${pending.id}`, undefined, bob.cookie)).status === 404, 'Cross-owner actual HTTP access accepted')
  const submitted = await request(`/api/credential-requests/${pending.id}/submit`, { nonce: pending.nonce, secret, save: false }, alice.cookie)
  check(submitted.status === 200, 'Actual secure submit failed')
  const notification = await app.query('SELECT text FROM run_messages WHERE id=$1', [pending.id])
  check(notification.rows[0]?.text.includes(pending.id) && !notification.rows[0].text.includes(secret), 'Real daemon notification queue not connected')
  const polled = await request(`/v1/devices/${deviceId}/commands`, undefined, '', deviceToken)
  check(polled.status === 200, 'Actual daemon command poll failed')
  const commands = await polled.json()
  check(commands.commands.some(command => command.kind === 'input' && command.runId === runId && command.messageId === pending.id && command.text.includes(pending.id)), 'Ready reference not delivered by actual daemon commands API')
  const used = await call('credential_use', { credentialRef: pending.id }); check(used.result === 'site_policy_verified', 'Actual worker tool could not use the reference')
  check((await call('credential_browser_action', { credentialRef: pending.id, action: { type: 'click', targetId: 'projects' } })).pageId === 'projects', 'Real worker navigation failed')
  const business = await call('credential_browser_action', { credentialRef: pending.id, action: { type: 'read', regionId: 'business' } })
  check(business.text === 'Project Alpine is ready for review', 'Actual protected business read failed')
  check((await call('credential_finish', { credentialRef: pending.id })).state === 'consumed', 'Actual worker finish failed')
  check((await call('credential_use', { credentialRef: pending.id })).error, 'Actual worker replay was accepted')
  check(vaultWrites === 1 && vaultReads >= 1 && vaultValues.size === 0 && vaultDeletes >= 1, 'Actual provider adapter lifecycle incomplete')
  const rows = await app.query('SELECT row_to_json(c)::text AS data FROM credential_requests c')
  check(!rows.rows.some(row => row.data.includes(secret) || row.data.includes(websiteCookie)), 'Secret stored in application database')
  for (const mode of ['cancel', 'expire']) {
    const fresh = await request('/api/credential-requests', prepared.submission.body, alice.cookie)
    check(fresh.status === 201, 'Actual follow-up secure request failed'); const requestState = await fresh.json()
    check((await request(`/api/credential-requests/${requestState.id}/submit`, { nonce: requestState.nonce, secret, save: false }, alice.cookie)).status === 200, 'Actual follow-up submit failed')
    if (mode === 'cancel') check((await request(`/api/credential-requests/${requestState.id}/cancel`, {}, alice.cookie)).status === 200, 'Actual HTTP cancel failed')
    else await app.query('UPDATE credential_requests SET use_expires_at=now()-interval \'1 second\' WHERE id=$1', [requestState.id])
    const status = await call('credential_status', { credentialRef: requestState.id })
    check(status.state === (mode === 'cancel' ? 'cancelled' : 'expired'), 'Actual harness lifecycle state mismatch')
    check((await call('credential_use', { credentialRef: requestState.id })).error, 'Actual harness accepted cancelled/expired use')
  }
  check(vaultValues.size === 0, 'Actual cancelled/expired requests left vault records')
  evidence.push({ result: 'PROVISIONAL', sourceCommit, sourceWorkingTreeClean: changed.length === 0, runId, taskId, requestId: pending.id, executionSession, origin, target: websiteOrigin, vault: 'synthetic HTTPS provider contract through real Infisical adapter', realInfisical: false, realUserOrExternalAccount: false, uiAcceptance: false, harnessModelInvoked: false, srtIsolationVerified: false, actualHarnessMcpChild: true, actualDaemonCommandPoll: true, actualMcpToolsRegisteredAndCalled: true, cancellationAndExpiryVerified: true })
} catch (error) {
  const message = error instanceof Error ? error.message : 'System acceptance failed'
  console.error([...secretMarkers].some(value => value && message.includes(value)) ? 'System acceptance failed; sensitive error suppressed.' : message); process.exitCode = 1
} finally {
  const cleanupIssues = []
  const cleanup = async (label, operation) => { try { await within(operation(), 12_000) } catch { cleanupIssues.push(label) } }
  await cleanup('harness_process', () => stopProcess(harness))
  if (closeHarnessBridge) await cleanup('daemon_bridge', closeHarnessBridge)
  await cleanup('next_process', () => stopProcess(next))
  for (const [label, server] of [['website_server', website], ['vault_server', vault]]) await cleanup(label, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())) })
  await cleanup('database_clients', () => Promise.all([app.end(), workspace.end()]))
  for (const name of created.reverse()) await cleanup('own_database_drop', () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`))
  await cleanup('database_admin', () => admin.end())
  const leaked = [...secretMarkers].some(value => value && (logs.includes(value) || harnessOutput.includes(value)))
  if (leaked) { process.exitCode = 1; console.error('FAIL: synthetic credential marker in runtime/harness output; raw output suppressed.') }
  if (cleanupIssues.length) { process.exitCode = 1; console.error('FAIL: local fixture cleanup was not confirmed: ' + cleanupIssues.join(', ')) }
  const passed = !process.exitCode && evidence.length > 0
  if (!evidence.length) evidence.push({ result: 'FAIL_LOCAL_SYSTEM' })
  for (const item of evidence) { item.result = passed ? 'PASS_LOCAL_SYSTEM_ONLY' : cleanupIssues.length ? 'FAIL_CLEANUP' : leaked ? 'FAIL_OUTPUT_CONFIDENTIALITY' : 'FAIL_LOCAL_SYSTEM'; item.cleanupIssues = cleanupIssues; item.outputConfidentialityPassed = !leaked }
  const safeLogs = leaked ? 'SUPPRESSED: synthetic secret marker appeared in runtime output\n' : logs
  await writeFile(join(directory, 'next.log'), safeLogs)
  await writeFile(join(directory, 'harness.log'), leaked ? 'SUPPRESSED\n' : harnessOutput)
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  if (passed) console.log('Actual Next/Mikka HTTP + actual harness MCP + controlled browser path: PASS (local fixtures; external and UI gates remain).')
  console.log(`System acceptance evidence: ${directory}`)
}
