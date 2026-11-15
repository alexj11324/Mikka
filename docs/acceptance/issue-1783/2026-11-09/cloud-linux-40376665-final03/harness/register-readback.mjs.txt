import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// This is a transport/acceptance fixture. The recordings show real earlier
// commands at this SHA; this fixture never pretends a model ran those commands.
const [repo, output, sha] = process.argv.slice(2)
assert.ok(repo && output)
assert.match(sha ?? '', /^[a-f0-9]{40}$/)
assert.ok(!process.env.CI, 'Local acceptance cannot impersonate CI')
const execute = promisify(execFile)
const run = (bin, args, options = {}) => execute(bin, args, { cwd: repo, timeout: 120_000, maxBuffer: 8_000_000, ...options })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const moduleAt = path => import(pathToFileURL(join(repo, path)).href)
const require = createRequire(join(repo, 'package.json'))
const { Pool } = require('pg')
const directory = await mkdtemp(join(tmpdir(), 'issue-1783-activity-'))
const destination = join(output, 'activity-readback')
await mkdir(destination)
const proof = { codeCommit: sha, startedAt: new Date().toISOString(), boundary: 'Isolated synthetic task graph; real cloud commands, captured terminal footage and authenticated HTTP transport. No model/provider execution is claimed.', http: [], captures: [], documents: [], checks: [], cleanup: {} }
let phase = 'fixed-revision', admin, pool, server, accounts, environment, applicationPool, workspacePool, auditDirectory
let databaseName, ownedDatabaseCreated = false, success = false
const knownSecrets = new Set()
const privateEnvironment = new Map()
const configure = (key, value) => { if (!privateEnvironment.has(key)) privateEnvironment.set(key, process.env[key]); process.env[key] = value }
const check = (condition, name) => { assert.ok(condition, name); proof.checks.push(name); console.log('PASS ' + name) }
const safeJson = value => JSON.stringify(value, null, 2) + '\n'
const assertPublic = value => {
  const text = typeof value === 'string' ? value : safeJson(value)
  assert.ok(!/\b(?:orv_|mkw_|mka_|mkr_|mkp_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/.test(text), 'Public evidence must not contain credential patterns')
  for (const secret of knownSecrets) if (secret.length >= 12) assert.ok(!text.includes(secret), 'Public evidence must not contain an authentication secret')
  return text
}
async function save(name, value) { await writeFile(join(destination, name), assertPublic(value)) }
async function freePort() {
  const socket = createServer()
  await new Promise((done, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', done) })
  const address = socket.address(); assert.ok(address && typeof address === 'object')
  await new Promise((done, fail) => socket.close(error => error ? fail(error) : done()))
  return address.port
}
try {
  assert.equal((await run('git', ['rev-parse', 'HEAD'])).stdout.trim(), sha, 'Exact source revision')
  await run('git', ['diff', '--quiet', 'HEAD', '--', '.', ':(exclude)docs/acceptance/issue-1783/**'])
  const receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))
  assert.equal(receipt.codeCommit, sha)
  assert.equal(receipt.stages.length, 3, 'Register exactly the three completed real execution segments')
  assert.ok(receipt.stages.every(stage => stage.exitCode === 0 && stage.terminalExitCode === 0 && stage.results.every(result => result.accepted)))
  proof.recordedStages = receipt.stages.map(stage => ({ id: stage.id, codeCommit: stage.codeCommit, startedAt: stage.startedAt, finishedAt: stage.finishedAt, durationMs: stage.video.durationMs }))
  const { assertE2eTarget } = await moduleAt('tests/helpers/e2e-target.mjs')
  const adminUrl = assertE2eTarget(process.env.E2E_DATABASE_URL)
  assert.equal(process.env.MIKKA_DATABASE_URL, adminUrl.toString())
  assert.equal(process.env.DATABASE_URL, adminUrl.toString())
  databaseName = `evidence_transport_${randomUUID().replaceAll('-', '')}_e2e`
  admin = new Pool({ connectionString: adminUrl.toString(), max: 1 })
  await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`)
  ownedDatabaseCreated = true
  const target = new URL(adminUrl); target.pathname = '/' + databaseName
  pool = new Pool({ connectionString: target.toString(), max: 5 })
  phase = 'isolated-migrations'
  const { orderMigrations } = await moduleAt('scripts/migration-order.mjs')
  const migrations = orderMigrations((await readdir(join(repo, 'drizzle'))).filter(file => file.endsWith('.sql')))
  for (const file of migrations) await pool.query(await readFile(join(repo, 'drizzle', file), 'utf8'))
  const databaseIdentity = (await pool.query("SELECT current_database() AS name,host(inet_server_addr()) AS address,current_setting('server_version') AS version")).rows[0]
  check(databaseIdentity.name === databaseName && databaseIdentity.version.startsWith('17.'), 'Own disposable PostgreSQL 17 database')
  proof.database = databaseIdentity; proof.migrations = migrations.length
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  proof.origin = origin
  const descriptor = join(directory, 'environment.json'), networkReceipt = join(directory, 'network.txt')
  for (const [key, value] of Object.entries({
    E2E_DATABASE_URL: target.toString(), MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), FACTORY_MONITOR_TEST_URL: target.toString(),
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), E2E_BASE_URL: origin, MIKKA_BASE_PATH: '/mikka',
    MIKKA_EDITION: 'cloud', NODE_ENV: 'test', MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_DEPLOYMENT_SHA: sha,
    MIKKA_TEST_ENVIRONMENT_FILE: descriptor, MIKKA_DEV_SKIP_ENV_FILES: '1', WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_BASE_URL: origin,
    MIKKA_TRACE_SAMPLE_RATE: '0', NEXT_PUBLIC_POSTHOG_KEY: '', WORKFLOW_LOCAL_DATA_DIR: join(directory, 'workflow'), FACTORY_ACTIVITY_HTTP_NETWORK_RECEIPT: networkReceipt,
  })) configure(key, value)
  if (process.env.ORVILO_DATABASE_URL) configure('ORVILO_DATABASE_URL', target.toString())
  const { BASE_PATH } = await moduleAt('lib/base-path.ts')
  assert.equal(BASE_PATH, '/mikka', 'Direct report generator uses the same base path as the application')
  proof.basePath = BASE_PATH
  knownSecrets.add(process.env.BETTER_AUTH_SECRET)
  for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) assert.ok(!process.env[key], 'Isolated fixture cannot use external object storage')
  const { bootstrapEnvironment, recordRunnerEvidenceSecrets } = await moduleAt('scripts/test-accounts/bootstrap.mjs')
  const { assertDeploymentIdentity, EnvironmentError } = await moduleAt('scripts/test-accounts/environment.mjs')
  const { acquireTestAccounts, recordAuthenticationSecrets, auditEvidence } = await moduleAt('scripts/test-accounts/session.mjs')
  environment = await bootstrapEnvironment({ connectionString: target.toString(), origin, deploymentSha: sha, id: `evidence-transport-${randomUUID()}`, outputFile: descriptor,
    authorizeDatabase: async database => {
      const actual = (await database.query('SELECT current_database() AS name,host(inet_server_addr()) AS address')).rows[0]
      if (actual.name !== databaseName) throw new EnvironmentError('ACTUAL_DATABASE_MISMATCH')
      if (!actual.address) throw new EnvironmentError('LOCAL_DATABASE_UNVERIFIED')
    } })
  auditDirectory = resolve(repo, '.cache/e2e/test-accounts', environment.instanceId)
  await recordRunnerEvidenceSecrets(environment)
  const remember = async values => { for (const value of values) knownSecrets.add(value); await recordAuthenticationSecrets(values, { environment }) }
  phase = 'real-vite-nitro-start'
  let stdoutBytes = 0, stderrBytes = 0
  const startupCodes = new Set()
  server = spawn(process.execPath, ['apps/api/scripts/dev.mjs', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${join(repo, 'tests/fixtures/factory-activity-http-network.mjs')}`.trim() },
  })
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('APPLICATION_START_TIMEOUT')), 180_000)
    let recent = '', settled = false
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? fail(error) : done() }
    server.once('error', () => finish(new Error('APPLICATION_START_FAILED')))
    server.once('exit', () => finish(new Error('APPLICATION_START_EXITED')))
    server.stdout.on('data', bytes => { stdoutBytes += bytes.length; recent = (recent + bytes.toString()).slice(-2048); if (/\[dev\] Ready in/.test(recent)) finish() })
    server.stderr.on('data', bytes => { stderrBytes += bytes.length; for (const match of bytes.toString().matchAll(/code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) startupCodes.add(match[1]) })
  })
  await assertDeploymentIdentity(environment)
  check(true, 'Real local Vite/Nitro application attests exact code SHA')
  phase = 'leased-account-login'
  accounts = await acquireTestAccounts({ database: pool, environment, runId: `evidence-transport-${randomUUID()}`, workerId: 'activity', requestId: randomUUID(), ttlMs: 300_000 })
  const owner = accounts.owner.userId
  const { seedWorkspace, seedBot, seedAgent, seedTeam } = await moduleAt('tests/support/workspace-admin-db.ts')
  const { WORKSPACE_SELECTION_HEADER } = await moduleAt('lib/workspace-selection.ts')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }], 'Issue 1783 isolated evidence transport')
  const selectedRequest = (account, path, init = {}) => {
    const headers = new Headers(init.headers); headers.set(WORKSPACE_SELECTION_HEADER, workspace.id)
    return account.request(path, { ...init, headers })
  }
  const ownerRequest = (path, init = {}) => selectedRequest(accounts.owner, path, init)
  const peerRequest = (path, init = {}) => selectedRequest(accounts.peer, path, init)
  function sameOrigin(path) { const url = new URL(path, origin); assert.equal(url.origin, origin, 'Artifact remains on application origin'); assert.equal(url.username, ''); assert.equal(url.password, ''); return url }
  async function request(path, init = {}, caller = 'public') {
    const url = sameOrigin(path), startedAt = new Date().toISOString()
    const response = caller === 'owner' ? await ownerRequest(url.pathname + url.search, init)
      : caller === 'peer' ? await peerRequest(url.pathname + url.search, init)
      : await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) })
    proof.http.push({ method: init.method ?? 'GET', path: url.pathname, caller, status: response.status, startedAt })
    // No headers, authorization material, auth response bodies or private URLs
    // are ever written to terminal output or the public proof.
    return response
  }
  const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const expectStatus = (response, status, label) => { assert.equal(response.status, status, label); return response }
  phase = 'normal-device-authorization'
  const daemonVersion = JSON.parse(await readFile(join(repo, 'packages/daemon/package.json'), 'utf8')).version
  const grantResponse = expectStatus(await request('/mikka/api/auth/device/code', json({ client_id: 'mikka-daemon', device_name: 'Issue 1783 evidence fixture', device_platform: 'linux', client_version: daemonVersion })), 200, 'Device grant')
  const grant = await grantResponse.json()
  assert.ok(typeof grant.device_code === 'string' && typeof grant.user_code === 'string')
  await remember([grant.device_code, grant.user_code])
  expectStatus(await request('/mikka/api/auth/device?user_code=' + encodeURIComponent(grant.user_code), {}, 'owner'), 200, 'Device grant review and owner claim')
  expectStatus(await request('/mikka/api/auth/device/approve', json({ userCode: grant.user_code }), 'owner'), 200, 'Device approval')
  await delay(Math.max(1, Number(grant.interval) || 5) * 1000)
  const credential = await (expectStatus(await request('/mikka/api/auth/device/token', json({ client_id: 'mikka-daemon', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })), 200, 'Device token exchange')).json()
  assert.ok(typeof credential.access_token === 'string' && /^orv_[A-Za-z0-9_-]{43}$/.test(credential.access_token))
  await remember([credential.access_token])
  const { CLIENT_VERSION_HEADER } = await moduleAt('packages/protocol/src/version.ts')
  const deviceHeaders = { authorization: `Bearer ${credential.access_token}`, [CLIENT_VERSION_HEADER]: daemonVersion }
  const deviceRequest = (path, init) => request(path, { ...init, headers: { ...init.headers, ...deviceHeaders } }, 'device')
  const registration = await (expectStatus(await deviceRequest('/mikka/v1/devices/register', json({ deviceType: 'server', name: 'Isolated recording transport fixture', platform: 'linux', arch: process.arch, daemonVersion, protocolVersion: 1, harnesses: [] })), 200, 'Device registration')).json()
  check(typeof registration.deviceId === 'string', 'Normal device grant, session approval, token exchange and registration')
  phase = 'synthetic-task-graph'
  const bot = await seedBot(pool, workspace.id, owner, 'Isolated evidence fixture'), agent = await seedAgent(pool, owner), team = await seedTeam(pool, workspace.id, owner)
  await pool.query('UPDATE agents SET name=$2,"deviceId"=$3 WHERE id=$1', [agent, 'Synthetic transport fixture — no model executed', registration.deviceId])
  const issueId = randomUUID(), taskId = randomUUID(), sourceEventId = randomUUID(), candidateId = randomUUID(), runId = randomUUID(), attemptId = randomUUID(), sessionId = randomUUID()
  const tokenId = (await pool.query('SELECT id FROM device_tokens WHERE "userId"=$1 AND "tokenHash"=$2', [owner, digest(credential.access_token)])).rows[0]?.id
  assert.ok(tokenId)
  await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") VALUES($1,$2,'Isolated fixture: issue 1783 real command evidence','{"type":"doc"}','todo','normal','workspace',$3,'bound')`, [issueId, owner, workspace.id])
  await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, team.id, workspace.id, owner])
  await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,$4,'user_message',$1::text,$5)`, [sourceEventId, owner, bot, issueId, JSON.stringify({ text: 'Isolated transport fixture for actual recorded commands. No model execution.' })])
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await tx.query(`INSERT INTO factory_tasks(id,"userId","workspaceId","botId","issueId","sourceEventId","scopeVersion",route,stage,status,revision,"attemptId",reason) SELECT $1,$2,$3,$4,$5,$6,"scopeVersion",$8,'execute','running',1,$7,'Synthetic transport fixture; no model executed' FROM issues WHERE id=$5`, [taskId, owner, workspace.id, bot, issueId, sourceEventId, attemptId,
      JSON.stringify({ flowVersion: 2, issueId, eventId: randomUUID(), sourceEventId, rationale: 'Synthetic transport fixture for the actual recorded fixed-revision commands', missingInformation: [], missingPermissions: [], needsSpec: false })])
    await tx.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId","botId","deviceId","deviceTokenId",kind,status,"sessionId","startedAt","leaseExpiresAt","agentDefinition") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'implement','running',$9,now(),now()+interval '20 minutes',$10)`, [runId, owner, workspace.id, issueId, agent, bot, registration.deviceId, tokenId, sessionId, JSON.stringify({ harness: 'codex', name: 'Synthetic transport fixture — no model executed' })])
    await tx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'fixture/issue-1783','isolated-cloud-linux','isolated-evidence-transport',$4)`, [candidateId, taskId, sha, runId])
    await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason,output) VALUES($1,$2,'execute',1,1,'running',$3,$4,$5,'Synthetic transport fixture; no model executed',$6)`, [attemptId, taskId, candidateId, runId, sessionId, JSON.stringify({ requestEpoch: sourceEventId })])
    await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, candidateId])
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  proof.fixture = { issueId, taskId, runId, attemptId, candidateId, workspaceId: workspace.id, codeCommit: sha, harnessMetadataOnly: true }
  console.log('Fixture task ' + taskId + ' / run ' + runId)
  const sources = receipt.stages.flatMap(stage => [
    { file: stage.id + '.mp4', contentType: 'video/mp4', durationMs: stage.video.durationMs, title: `Actual cloud command recording: ${stage.id}`, stageId: stage.id },
    { file: stage.id + '-result.png', contentType: 'image/png', title: `Actual terminal result screenshot: ${stage.id}`, stageId: stage.id },
  ])
  phase = 'normal-capture-upload'
  for (const source of sources) {
    const bytes = await readFile(join(output, source.file)), captureId = randomUUID(), sha256 = digest(bytes)
    assert.ok(bytes.length <= 4_000_000, 'Capture fits documented inline upload limit')
    const body = { captureId, title: source.title, contentType: source.contentType, size: bytes.length, sha256,
      ...(source.durationMs ? { durationMs: source.durationMs, steps: [] } : {}) }
    const path = `/mikka/v1/runs/${runId}/captures`
    const begin = await (expectStatus(await deviceRequest(path, json(body)), 201, 'Capture begin')).json()
    assert.equal(begin.captureId, captureId); assert.equal(begin.upload.target, 'server')
    expectStatus(await deviceRequest(`${path}/${captureId}`, { method: 'PUT', headers: { 'content-type': source.contentType }, body: bytes }), 204, 'Capture PUT')
    const completed = await (expectStatus(await deviceRequest(`${path}/${captureId}/complete`, { method: 'POST', headers: {} }), 200, 'Capture complete')).json()
    assert.equal(completed.capture.id, captureId)
    proof.captures.push({ ...source, captureId, runId, size: bytes.length, sha256, completed: true })
    console.log(`PASS capture begin/PUT/complete: ${source.file} (${bytes.length} bytes)`)
  }
  check(proof.captures.length === 6, 'All three real recordings and three key screenshots completed through HTTP')
  const activityPath = `/mikka/api/factory/tasks/${taskId}/activity`
  const acceptanceHref = captureId => `${origin}/mikka/api/captures/${captureId}`
  const mediaHref = captureId => `${origin}/mikka/api/factory/tasks/${taskId}/media/${captureId}`
  const captureRows = proof.captures.map(capture => `| ${capture.file} | ${capture.size} | \`${capture.sha256}\` | [same-origin media](${mediaHref(capture.captureId)}) |`).join('\n')
  const commandDetails = receipt.stages.map(stage => `## ${stage.title}\n\n${stage.startedAt} — ${stage.finishedAt}\n\n${stage.results.map(result => '```sh\n' + result.command.join(' ') + '\n```\n\nExit ' + result.exitCode + (result.tests ? '; actual tests ' + JSON.stringify(result.tests) : '') + '.').join('\n\n')}`).join('\n\n')
  const details = `# Issue 1783: fixed-revision cloud acceptance evidence\n\nCode: \`${sha}\`.\n\n${proof.boundary}\n\nThe recordings were produced before this independently created task graph. This graph validates the existing authenticated upload, provenance projection, versioned document and same-origin read paths; it is not a production model task.\n\nApplication: ${origin}.\n\nActivity: [authenticated activity](${origin}${activityPath}).\n\n| Real execution evidence | Bytes | SHA-256 | Application link |\n| --- | --- | --- | --- |\n${captureRows}\n\n${commandDetails}\n\nFFmpeg oversize regression uses a clearly synthetic decodable red/gray/blue source and retains the first and last actions. The terminal recordings themselves are real X11 capture of running commands, not replayed output. All normal begin/PUT/complete requests succeeded. Exact HTTP paths/statuses and independent GET byte/decode proofs are archived in activity-readback/proof.json.\n`
  phase = 'real-mcp-versioned-document'
  await import(pathToFileURL(require.resolve('next/dist/server/node-environment-baseline')).href)
  applicationPool = (await moduleAt('lib/db/index.ts')).pool
  workspacePool = (await moduleAt('lib/workspace-db.ts')).workspacePool
  const worker = await moduleAt('lib/mcp/worker.ts')
  const delegation = await worker.issueRunToken({ id: runId, userId: owner })
  await remember([delegation.token])
  let mcpSession, protocol = '2025-06-18', sequence = 0
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++sequence
    const response = await request('/mikka/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${delegation.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) }, 'worker')
    assert.ok(response.ok, 'Actual MCP HTTP request succeeds')
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession
    if (mcpSession) await remember([mcpSession])
    if (notification || response.status === 202) { await response.body?.cancel(); return }
    const text = await response.text()
    const message = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text)
      : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === id)
    assert.ok(message && !message.error, 'Actual successful JSON-RPC response')
    return message.result
  }
  const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'issue-1783-evidence-harness', version: '1' } })
  protocol = initialized.protocolVersion
  await rpc('notifications/initialized', undefined, true)
  async function submit(content, artifactId, title = 'Issue 1783 actual cloud command evidence — isolated fixture') {
    const result = await rpc('tools/call', { name: 'submit_artifact', arguments: { title, kind: 'markdown', content, ...(artifactId ? { artifactId } : {}) } })
    assert.ok(!result.isError, 'Actual MCP submit_artifact succeeds')
    const value = JSON.parse(result.content.find(block => block.type === 'text').text)
    assert.ok(!value.error && value.artifactId && Number.isInteger(value.version), 'MCP submission receipt')
    return value
  }
  const first = await submit(details)
  const firstBytes = Buffer.from(await (expectStatus(await request(first.path, {}, 'owner'), 200, 'First document GET')).arrayBuffer())
  const firstStored = (await pool.query('SELECT sha256 FROM artifact_versions WHERE "artifactId"=$1 AND version=$2', [first.artifactId, first.version])).rows[0]
  assert.equal(digest(firstBytes), firstStored.sha256)
  const second = await submit(details + `\n## Transport observation\n\nThe first report version was fetched over authenticated HTTP with status 200. SHA-256: \`${digest(firstBytes)}\`. Version 2 retains the same execution facts and records that observation. The immutable first version remains at [version 1](${origin}${first.path}).\n`, first.artifactId)
  check(second.version === first.version + 1, 'Real MCP submits two immutable detailed report versions')
  const firstAgain = Buffer.from(await (expectStatus(await request(first.path, {}, 'owner'), 200, 'Immutable first document GET')).arrayBuffer())
  check(digest(firstAgain) === digest(firstBytes), 'First document bytes remain unchanged after version 2')
  const screenshotContent = `# Issue 1783: actual screenshot index\n\nCode: \`${sha}\`.\n\n${proof.boundary}\n\nThis immutable document indexes the three uploaded result screenshots and their corresponding actual cloud terminal recordings. All inline image and video links use this application's own origin. The later registration/readback recording is a separate static witness and is not an activity capture.\n\n` + receipt.stages.map(stage => {
    const picture = proof.captures.find(capture => capture.stageId === stage.id && capture.contentType === 'image/png')
    const video = proof.captures.find(capture => capture.stageId === stage.id && capture.contentType === 'video/mp4')
    assert.ok(picture && video)
    return `## ${stage.title}\n\nActual execution: ${stage.startedAt} — ${stage.finishedAt}. Result frame: approximately ${(stage.video.durationMs / 1000 - 2).toFixed(2)} seconds into the recording.\n\n![Actual result screenshot: ${stage.id}](${mediaHref(picture.captureId)})\n\n[Corresponding actual terminal recording](${mediaHref(video.captureId)})\n\nScreenshot SHA-256: \`${picture.sha256}\`. Video SHA-256: \`${video.sha256}\`.\n`
  }).join('\n')
  const screenshotIndex = await submit(screenshotContent, undefined, 'Issue 1783 actual screenshot index — fixed revision cloud commands')
  proof.screenshotIndex = { artifactId: screenshotIndex.artifactId, version: screenshotIndex.version, imageCount: 3, videoLinkCount: 3 }
  check(screenshotIndex.version === 1, 'Real MCP submits an immutable screenshot index with three same-origin images and recordings')
  phase = 'existing-acceptance-generation'
  const criteria = receipt.stages.map(stage => ({ criterionId: randomUUID(), text: stage.title, passed: true, status: 'passed',
    command: stage.results.map(result => result.command.join(' ')).join(' && ').slice(0, 1990), exitCode: 0,
    reason: 'Observed actual commands in cloud Linux at the recorded fixed revision. This task is a synthetic transport fixture.',
    evidence: stage.results.map(result => result.tests ? JSON.stringify(result.tests) : `exit=${result.exitCode}`).join('; ') + '\n' + proof.captures.filter(capture => capture.stageId === stage.id).map(capture => `run-capture:${capture.captureId}`).join('\n') }))
  const report = { summary: `Fixed code ${sha}: real cloud PostgreSQL/API/MCP CLI/FFmpeg checks passed. This run is explicitly a synthetic evidence transport fixture, not model execution. Detailed commands are in Artifact ${first.artifactId} v${second.version}.`, criteria, filesChanged: [], verify: { status: 'passed', command: `node issue-1783-harness/run.mjs ${sha}`, output: 'All three recorded command stages succeeded with zero skipped tests. All six captures completed through normal authenticated HTTP.' }, visualEvidence: proof.captures.map(capture => ({ captureId: capture.captureId, publicSafe: false })) }
  await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',report=$2,"finishedAt"=now() WHERE id=$1`, [runId, JSON.stringify(report)])
  await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=now() WHERE id=$1`, [attemptId])
  await pool.query(`UPDATE factory_tasks SET stage='execute',status='passed',reason='Actual recorded commands passed; isolated transport fixture' WHERE id=$1`, [taskId])
  const { syncFactoryPresentation } = await moduleAt('lib/factory/stage-progress.ts')
  async function presentation() {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const task = (await tx.query('SELECT * FROM factory_tasks WHERE id=$1', [taskId])).rows[0]; await syncFactoryPresentation(tx, task); await tx.query('COMMIT') }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  await presentation()
  const acceptance = (await pool.query('SELECT f."artifactId",f.sha256,a."latestVersion" FROM factory_acceptance_artifacts f JOIN artifacts a ON a.id=f."artifactId" WHERE f."taskId"=$1', [taskId])).rows[0]
  check(Boolean(acceptance), 'Existing syncFactoryPresentation generates acceptance Artifact')
  await presentation()
  const acceptanceAgain = (await pool.query('SELECT f.sha256,a."latestVersion" FROM factory_acceptance_artifacts f JOIN artifacts a ON a.id=f."artifactId" WHERE f."taskId"=$1', [taskId])).rows[0]
  check(acceptanceAgain.sha256 === acceptance.sha256 && acceptanceAgain.latestVersion === acceptance.latestVersion, 'Unchanged presentation preserves immutable acceptance version')
  phase = 'authenticated-activity-get'
  const activityResponse = expectStatus(await request(activityPath, {}, 'owner'), 200, 'Activity GET')
  assert.match(activityResponse.headers.get('cache-control') ?? '', /private.*no-store/)
  const activity = await activityResponse.json()
  assert.equal(activity.version, 1)
  assert.ok(Array.isArray(activity.artifacts))
  assert.ok(!/"(?:storageKey|inlineContent|tokenHash|access_token|refresh_token)"/.test(JSON.stringify(activity)), 'Activity is a safe projection')
  await save('activity.json', activity)
  check(proof.captures.every(capture => activity.artifacts.some(item => item.captureId === capture.captureId && item.runId === runId)), 'Activity returns all same-run image/video evidence')
  check(activity.artifacts.some(item => item.kind === 'acceptance' && item.artifactId === acceptance.artifactId), 'Activity returns generated immutable acceptance report')
  check(activity.artifacts.filter(item => item.kind === 'document' && item.artifactId === first.artifactId).length === 2, 'Activity returns both detailed report versions')
  check(activity.artifacts.some(item => item.kind === 'document' && item.artifactId === screenshotIndex.artifactId && item.version === screenshotIndex.version), 'Activity returns the immutable screenshot index document')
  expectStatus(await request(activityPath), 401, 'Anonymous activity refusal')
  expectStatus(await request(activityPath, {}, 'peer'), 404, 'Unrelated peer activity refusal')
  proof.access = { anonymous: 401, unrelatedPeer: 404 }
  phase = 'same-origin-byte-and-decode-readback'
  for (const item of activity.artifacts) {
    if (item.captureId) {
      const expected = proof.captures.find(capture => capture.captureId === item.captureId)
      assert.ok(expected)
      const response = expectStatus(await request(item.url, {}, 'owner'), 200, 'Activity media GET')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(digest(bytes), expected.sha256); assert.equal(bytes.length, expected.size)
      expected.get = { path: sameOrigin(item.url).pathname, status: 200, size: bytes.length, sha256: digest(bytes), sameOrigin: true }
      const downloaded = join(directory, expected.file)
      await writeFile(downloaded, bytes)
      await run('ffmpeg', ['-v', 'error', '-i', downloaded, '-f', 'null', '-'])
      expected.get.decodeExitCode = 0
      // Keep the actual authenticated GET bytes as the public media. They have
      // already been proved byte-identical to the completed uploaded capture.
      await writeFile(join(output, expected.file), bytes)
      expected.get.archivedFile = expected.file
      expected.get.archiveSource = 'authenticated-activity-get'
      if (item.kind === 'video') {
        expected.get.ffprobe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height', '-of', 'json', downloaded])).stdout)
        const range = expectStatus(await request(item.url, { headers: { range: 'bytes=0-63' } }, 'owner'), 206, 'Video range GET')
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 64))
        expected.get.rangeStatus = 206
      }
      const alias = expectStatus(await request(acceptanceHref(item.captureId), {}, 'owner'), 200, 'Acceptance embedded media GET')
      assert.equal(digest(Buffer.from(await alias.arrayBuffer())), expected.sha256)
      expected.get.reportEmbeddedPath = sameOrigin(acceptanceHref(item.captureId)).pathname
      console.log('PASS activity GET + SHA-256 + decode: ' + expected.file)
    } else if (item.artifactId) {
      const response = expectStatus(await request(item.downloadUrl, {}, 'owner'), 200, 'Versioned report GET')
      const bytes = Buffer.from(await response.arrayBuffer())
      const stored = (await pool.query('SELECT sha256,size FROM artifact_versions WHERE "artifactId"=$1 AND version=$2', [item.artifactId, item.version])).rows[0]
      assert.equal(digest(bytes), stored.sha256); assert.equal(bytes.length, stored.size)
      const filename = `${item.kind}-${item.artifactId}-v${item.version}.md`
      await save(filename, bytes.toString('utf8'))
      const purpose = item.artifactId === screenshotIndex.artifactId ? 'screenshot-index' : item.kind === 'acceptance' ? 'acceptance' : 'detailed-report'
      proof.documents.push({ kind: item.kind, purpose, artifactId: item.artifactId, version: item.version, runId: item.runId, file: filename, path: sameOrigin(item.downloadUrl).pathname, size: bytes.length, sha256: digest(bytes), status: 200, sameOrigin: true })
      if (purpose === 'screenshot-index') for (const capture of proof.captures) assert.ok(bytes.toString('utf8').includes(mediaHref(capture.captureId)), 'Screenshot index contains each same-origin image and recording')
      if (item.kind === 'acceptance') {
        assert.equal(digest(bytes), acceptance.sha256)
        for (const capture of proof.captures) assert.ok(bytes.toString('utf8').includes(acceptanceHref(capture.captureId)), 'Acceptance contains each same-origin capture')
      }
      console.log(`PASS immutable ${item.kind} v${item.version}: GET + SHA-256`)
    }
  }
  check(proof.captures.every(capture => capture.get?.decodeExitCode === 0), 'Every downloaded image/video decoded successfully')
  proof.applicationDiagnostics = { stdoutBytes, stderrBytes, startupCodes: [...startupCodes] }
  const network = await readFile(networkReceipt, 'utf8')
  proof.network = { guardStarts: network.split('\n').filter(line => line === 'guard-start').length, blockedExternalAttempts: network.split('\n').filter(line => line === 'blocked').length, policy: 'Child application allows only loopback HTTP, local PostgreSQL and IPC; no external provider is used.' }
  // Known-secret scanning covers all text projections and reports. Actual PNG
  // readability and image-level secret inspection are a separate visual review.
  await save('proof.json', proof)
  const auditPaths = (await readdir(destination)).filter(name => /\.(?:json|md)$/.test(name)).map(name => join(destination, name))
  proof.secretAudit = await auditEvidence(auditPaths, { environment })
  check(proof.secretAudit.result === 'passed', 'Public JSON and Markdown pass known credential/cookie audit')
  success = true
} catch (error) {
  proof.failure = { phase, code: String(error?.code ?? error?.name ?? 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80),
    location: String(error?.stack ?? '').split('\n').slice(1).filter(line => line.includes('register-readback.mjs:')).map(line => line.trim()).slice(0, 2) }
  console.error('FAIL evidence registration/readback phase=' + phase + ' code=' + proof.failure.code)
  process.exitCode = 1
} finally {
  const cleanup = async (name, work) => { try { await work(); proof.cleanup[name] = 'completed' } catch { proof.cleanup[name] = 'failed'; success = false; process.exitCode = 1 } }
  if (accounts) await cleanup('leasedAccountsReleased', () => accounts.release({ outcome: 'dirty' }))
  if (server) await cleanup('ownedApplicationStopped', async () => { const { stopOwnedApplication } = await moduleAt('apps/desktop/test/production-application.mjs'); await stopOwnedApplication(server) })
  if (applicationPool) await cleanup('applicationPoolClosed', () => applicationPool.end())
  if (workspacePool) await cleanup('workspacePoolClosed', () => workspacePool.end())
  if (pool) await cleanup('fixturePoolClosed', () => pool.end())
  if (ownedDatabaseCreated) await cleanup('ownDisposableDatabaseDropped', async () => { const { dropTestDatabase } = await moduleAt('tests/support/drop-test-database.ts'); await dropTestDatabase(admin, databaseName) })
  if (admin) await cleanup('adminPoolClosed', () => admin.end())
  if (auditDirectory) await cleanup('ownPrivateAccountStateRemoved', () => rm(auditDirectory, { recursive: true, force: true }))
  await cleanup('privateWorkingDirectoryRemoved', () => rm(directory, { recursive: true, force: true }))
  for (const [key, value] of privateEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  proof.finishedAt = new Date().toISOString(); proof.exitCode = success ? 0 : 1
  await save('proof.json', proof)
  console.log(`${success ? 'PASS' : 'FAIL'} activity registration/readback; captures=${proof.captures.length}; documents=${proof.documents.length}; checks=${proof.checks.length}; cleanup=${Object.values(proof.cleanup).every(value => value === 'completed') ? 'complete' : 'failed'}`)
}
