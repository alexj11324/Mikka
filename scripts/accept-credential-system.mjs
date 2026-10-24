// Actual Next/Mikka route acceptance, isolated databases and synthetic external TLS vault/website.
// This does NOT satisfy real Infisical, real account, UI screenshot or deployed acceptance gates.
import { Pool } from 'pg'
import { createServer } from 'node:http'
import { createServer as createTLS } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, symlink, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const supplied = process.env.CREDENTIAL_TEST_ADMIN_DATABASE_URL
if (!supplied) throw new Error('An isolated loopback CREDENTIAL_TEST_ADMIN_DATABASE_URL is required')
const adminURL = new URL(supplied)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminURL.hostname) || adminURL.pathname !== '/postgres') throw new Error('Loopback /postgres only')
const directory = await mkdtemp(join(tmpdir(), 'mikka-system-credential-'))
const nativeCache = await mkdtemp(join(root, '../.cache/mik79-swc-'))
const appDirectory = join(directory, 'app'); await mkdir(appDirectory)
execFileSync('git', ['archive', '--output', join(directory, 'source.tar'), 'HEAD'], { cwd: root })
execFileSync('tar', ['-xf', join(directory, 'source.tar'), '-C', appDirectory])
const changed = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
for (const path of changed) {
  if (path.split('/').some(part => part === '..' || part === '.git' || part.startsWith('.env'))) throw new Error('Unsafe source snapshot path')
  await mkdir(dirname(join(appDirectory, path)), { recursive: true }); await copyFile(join(root, path), join(appDirectory, path))
}
await symlink(join(root, 'node_modules'), join(appDirectory, 'node_modules'))
const suffix = randomUUID().replaceAll('-', '')
const names = [`mikka_credential_test_system_app_${suffix}`, `mikka_credential_test_system_workspace_${suffix}`]
const urls = names.map(name => { const url = new URL(supplied); url.pathname = `/${name}`; return url.href })
const admin = new Pool({ connectionString: supplied, max: 1 }), created = []
const app = new Pool({ connectionString: urls[0] }), workspace = new Pool({ connectionString: urls[1] })
const secret = `fixture-${randomBytes(30).toString('hex')}`, vaultToken = randomBytes(24).toString('hex')
const websiteCookie = randomBytes(24).toString('hex'), vaultValues = new Map(), evidence = []
let next, logs = '', vaultReads = 0, vaultWrites = 0, vaultDeletes = 0
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
try {
  for (const name of names) { await admin.query(`CREATE DATABASE "${name}"`); created.push(name) }
  const websiteOrigin = `http://127.0.0.1:${await listen(website)}`
  const vaultOrigin = `https://127.0.0.1:${await listen(vault)}`
  const reservation = createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'development', CI: 'true', NEXT_TELEMETRY_DISABLED: '1',
    SWC_NATIVE_BINDING_CACHE: nativeCache,
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
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
    const response = await request('/api/auth/sign-up/email', { name: 'System fixture', email: `${label}-${suffix}@example.test`, password: randomBytes(20).toString('hex') })
    check(response.status === 200, 'Actual Better Auth signup failed')
    const data = await response.json(), cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    check(cookie && data.user?.id, 'Actual Better Auth cookie missing'); return { id: data.user.id, cookie }
  }
  const alice = await signup('alice'), bob = await signup('bob')
  const deviceToken = `orv_${randomBytes(30).toString('hex')}`
  await app.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), alice.id, createHash('sha256').update(deviceToken).digest('hex')])
  const registered = await request('/v1/devices/register', { name: 'System credential fixture', platform: 'linux', arch: 'x64', daemonVersion: 'fixture', protocolVersion: 1, harnesses: [] }, '', deviceToken)
  check(registered.status === 200, 'Actual device registration failed'); const { deviceId } = await registered.json()
  const workspaceId = randomUUID(), teamId = randomUUID(), taskId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), runId = randomUUID(), executionSession = randomUUID()
  await workspace.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)', [workspaceId, alice.id, 'System fixture'])
  await workspace.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,$3,$4,$5)', [workspaceId, alice.id, 'Fixture', 'fixture@example.test', 'admin'])
  await workspace.query('INSERT INTO orvilo_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [teamId, workspaceId, alice.id, 'Fixture', 'FIX'])
  await app.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,$3,$4,$5,$6)', [taskId, alice.id, 'System credential test', { type: 'doc', content: [] }, 'doing', 'none'])
  await workspace.query('INSERT INTO orvilo_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [taskId, teamId, workspaceId, alice.id])
  await app.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agentId, alice.id, 'codex', 'System fixture', deviceId])
  await app.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [repoId, deviceId, alice.id, '/tmp/synthetic-system-repo'])
  await app.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId") VALUES ($1,$2,$3,$4,$5,$6)', [runId, alice.id, taskId, agentId, deviceId, repoId])
  const claim = await request(`/v1/devices/${deviceId}/runs/${runId}/claim`, {}, '', deviceToken)
  check(claim.status === 200, 'Actual run claim failed'); const assignment = await claim.json(); check(assignment.mcp?.token, 'Actual run-scoped MCP assignment missing')
  const patched = await fetch(`${base}/v1/runs/${runId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'running', sessionId: executionSession }) })
  check(patched.status === 204, 'Actual execution session patch failed')
  let mcpSession, seq = 0
  async function rpc(method, params) {
    const response = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${assignment.mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(30_000) })
    check(response.ok, `Actual MCP request failed (${response.status})`)
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession
    const text = await response.text(); check(!text.includes(secret) && !text.includes(websiteCookie) && !text.includes(vaultToken), 'Secret in actual MCP output')
    const payload = text.startsWith('data:') || text.includes('\ndata:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === seq) : JSON.parse(text)
    check(payload?.result && !payload.error, 'Actual MCP protocol result missing'); return payload.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mikka-credential-system-acceptance', version: '1' } })
  const initialized = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${assignment.mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) })
  check(initialized.ok, 'Actual MCP initialized notification failed'); await initialized.body?.cancel()
  const listed = await rpc('tools/list', {}); check(listed.tools.some(t => t.name === 'credential_browser_action'), 'Credential tool not registered in actual worker MCP')
  async function call(name, args) { const result = await rpc('tools/call', { name, arguments: args }); return JSON.parse(result.content[0].text) }
  const prepared = await call('prepare_credential_request', { serviceId: 'system-site', mode: 'browser_login' })
  check(prepared.runId === runId && prepared.workspaceId === workspaceId, 'Real tool context was not server bound')
  const form = await request('/api/credential-requests', prepared.submission.body, alice.cookie)
  check(form.status === 201, 'Actual credential route did not create request'); const pending = await form.json()
  check((await request(`/api/credential-requests/${pending.id}`, undefined, bob.cookie)).status === 404, 'Cross-owner actual HTTP access accepted')
  const submitted = await request(`/api/credential-requests/${pending.id}/submit`, { nonce: pending.nonce, secret, save: false }, alice.cookie)
  check(submitted.status === 200, 'Actual secure submit failed')
  const notification = await app.query('SELECT text FROM run_messages WHERE id=$1', [pending.id])
  check(notification.rows[0]?.text.includes(pending.id) && !notification.rows[0].text.includes(secret), 'Real daemon notification queue not connected')
  const used = await call('credential_use', { credentialRef: pending.id }); check(used.result === 'site_policy_verified', 'Actual worker tool could not use the reference')
  check((await call('credential_browser_action', { credentialRef: pending.id, action: { type: 'click', targetId: 'projects' } })).pageId === 'projects', 'Real worker navigation failed')
  const business = await call('credential_browser_action', { credentialRef: pending.id, action: { type: 'read', regionId: 'business' } })
  check(business.text === 'Project Alpine is ready for review', 'Actual protected business read failed')
  check((await call('credential_finish', { credentialRef: pending.id })).state === 'consumed', 'Actual worker finish failed')
  check((await call('credential_use', { credentialRef: pending.id })).error, 'Actual worker replay was accepted')
  check(vaultWrites === 1 && vaultReads >= 1 && vaultValues.size === 0 && vaultDeletes >= 1, 'Actual provider adapter lifecycle incomplete')
  const rows = await app.query('SELECT row_to_json(c)::text AS data FROM credential_requests c')
  check(!rows.rows.some(row => row.data.includes(secret) || row.data.includes(websiteCookie)), 'Secret stored in application database')
  evidence.push({ result: 'PASS_LOCAL_SYSTEM_ONLY', runId, taskId, requestId: pending.id, executionSession, origin, target: websiteOrigin, vault: 'synthetic HTTPS provider contract through real Infisical adapter', realInfisical: false, realUserOrExternalAccount: false, uiAcceptance: false, harnessModelInvoked: false, actualMcpToolsRegisteredAndCalled: true })
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('Actual Next/Mikka HTTP + authenticated worker MCP + controlled browser path: PASS (local fixtures; external and UI gates remain).')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'System acceptance failed'); process.exitCode = 1
} finally {
  if (next) { next.kill('SIGTERM'); await Promise.race([once(next, 'close'), new Promise(resolve => setTimeout(resolve, 5000))]); if (next.exitCode === null) next.kill('SIGKILL') }
  for (const server of [website, vault]) { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())) }
  await Promise.all([app.end(), workspace.end()])
  for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
  await admin.end()
  const safeLogs = [secret, vaultToken, websiteCookie].some(value => logs.includes(value)) ? 'SUPPRESSED: synthetic secret marker appeared in runtime output\n' : logs
  await writeFile(join(directory, 'next.log'), safeLogs)
  console.log(`System acceptance evidence: ${directory}`)
}
