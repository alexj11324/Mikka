// HTTP + real daemon acceptance. Never import Playwright or impersonate CI.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { assertDevLocal } from './guard.mjs'
import { bootstrapEnvironment, recordRunnerEvidenceSecrets } from '../test-accounts/bootstrap.mjs'
import { acquireTestAccounts, recordAuthenticationSecrets } from '../test-accounts/session.mjs'
import { TestAccountPool } from '../test-accounts/pool.mjs'
import { verifyMailbox } from './mailbox-acceptance.mjs'
import { verifyWorkerMailbox } from './worker-mailbox-acceptance.mjs'

const root = resolve(import.meta.dirname, '../..')
const selectedItems = process.env.LOCAL_LOOP_ITEMS?.split(',') ?? ['1', '2', '3', '4', '5', '6', '7']
assert.ok(selectedItems.length && selectedItems.every(item => /^[1-8]$/.test(item)) && new Set(selectedItems).size === selectedItems.length, 'LOCAL_LOOP_ITEMS must be unique item numbers 1–8')
const needsDaemon = selectedItems.some(item => ['1', '2', '3', '7'].includes(item))
// Keep the daemon Unix socket below Linux's 108-byte pathname limit even in
// the separate fixed acceptance checkout. Evidence retains the full runId.
const runId = randomUUID(), directory = resolve(root, '.cache/dev-local', `acceptance-${runId.replaceAll('-', '').slice(0, 16)}`)
const progressFile = resolve(root, '.cache/dev-local/progress.jsonl')
const started = Date.now(), children = [], secrets = new Set()
const completedItems = []
let pool, accounts, environment, runtime, activeStep, cleanupPromise, sourceFingerprint, serviceFailure, releaseHold, output = '', daemonCode, interrupted = false
async function fingerprint() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'app', 'lib', 'packages', 'scripts', 'agents', 'drizzle', 'package.json', 'pnpm-lock.yaml', 'next.config.mjs'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const path of paths) { hash.update(`${path}\0`); hash.update(await readFile(join(root, path)).catch(() => Buffer.from('[deleted]'))) }
  return hash.digest('hex')
}
const redact = value => {
  let result = String(value)
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]')
  return result.replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/gi, '[database]').replace(/(?:orv_|mkw_)[A-Za-z0-9_-]+/g, '[credential]').replace(/(authorization|cookie|api.?key|password|secret)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]')
}
async function progress(step, status, detail) {
  const entry = { at: new Date().toISOString(), runId, step, status, elapsedMs: Date.now() - started, ...(detail ? { detail: redact(detail) } : {}) }
  await appendFile(progressFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  console.log(`${step} ${status}${detail ? `: ${redact(detail)}` : ''}`)
}
async function step(name, timeout, action) {
  activeStep = name
  await progress(name, 'start')
  const controller = new AbortController()
  const heartbeat = setInterval(() => { void progress(name, 'heartbeat') }, 15_000)
  let timer
  try {
    const result = await Promise.race([action(controller.signal), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`${name}: timeout after ${timeout}ms`)) }, timeout) })])
    await progress(name, 'ok')
    return result
  } catch (error) {
    await progress(name, 'fail', error.message)
    throw error
  } finally { clearTimeout(timer); clearInterval(heartbeat) }
}
async function until(signal, predicate) {
  for (;;) {
    signal.throwIfAborted()
    if (interrupted) throw new Error('Acceptance interrupted')
    if (serviceFailure) throw serviceFailure
    const result = await predicate()
    if (result) return result
    await delay(250, undefined, { signal })
  }
}
function child(command, args, env = process.env, persistent = false) {
  const processChild = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(processChild)
  processChild.on('error', () => { if (persistent && !cleanupPromise) serviceFailure = new Error('An owned acceptance service could not start') })
  processChild.once('exit', (code, signal) => {
    if (persistent && !cleanupPromise) serviceFailure = new Error(`An owned acceptance service exited (${signal ?? code}); inspect the redacted service log`)
  })
  const capture = data => {
    const chunk = data.toString()
    const code = /Your code:\s*([A-Z0-9-]+)/.exec(chunk)?.[1]
    if (code) { daemonCode = code; secrets.add(code) }
    const safe = redact(chunk)
    output = (output + safe).slice(-24_000)
    void appendFile(join(directory, 'services.log'), safe, { mode: 0o600 }).catch(() => {})
  }
  processChild.stdout.on('data', capture); processChild.stderr.on('data', capture)
  return processChild
}
async function command(args) {
  const job = child(process.execPath, args)
  const status = await new Promise((done, reject) => { job.once('exit', done); job.once('error', reject) })
  assert.equal(status, 0, `CLI ${args[0]} exited ${status}`)
}
async function json(account, path, body, method = body ? 'POST' : 'GET') {
  const response = await account.request(path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return response.json()
}
const query = async (sql, values = []) => (await pool.query(sql, values)).rows
const run = async id => (await query('SELECT r.*,p.status AS publication,p."pullRequest" FROM agent_runs r LEFT JOIN run_publications p ON p."runId"=r.id WHERE r.id=$1 AND r."userId"=$2', [id, accounts.owner.userId]))[0]

async function dispatch(name, text, signal) {
  const since = new Date()
  await json(accounts.owner, '/api/coordinator/messages', { text: `${text}\n验收标记：${runId}-${name}`, submissionId: randomUUID() })
  const created = await until(signal, async () => (await query('SELECT id FROM agent_runs WHERE "userId"=$1 AND "createdAt">=$2 AND prompt LIKE $3 ORDER BY "createdAt" DESC LIMIT 1', [accounts.owner.userId, since, `%${runId}-${name}%`]))[0])
  await progress(name, 'run-created', created.id)
  return created.id
}
async function terminal(id, signal) {
  return until(signal, async () => { const current = await run(id); return ['succeeded', 'failed', 'stopped', 'cancelled'].includes(current?.status) ? current : null })
}
async function observations() {
  const response = await fetch('http://127.0.0.1:3191/observations', { signal: AbortSignal.timeout(10_000) })
  assert.ok(response.ok, 'local GitHub observations unavailable')
  return response.json()
}

async function setup() {
  assertDevLocal(process.env)
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24')
  for (const name of ['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID']) assert.ok(!process.env[name], 'Local acceptance must not impersonate CI')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // The daemon's unprivileged UID needs traverse permission, never access to
  // account/session files (which remain 0600 inside their own 0700 store).
  if (process.getuid?.() === 0 && process.env.MIKKA_DEV_DAEMON_USER) await chmod(directory, 0o711)
  for (const name of ['BETTER_AUTH_SECRET', 'DEEPSEEK_API_KEY', 'INFISICAL_CLIENT_SECRET']) if (process.env[name]) secrets.add(process.env[name])
  const existing = process.argv.includes('--existing')
  if (selectedItems.includes('8') && !existing) {
    // The cloud leg is explicitly selected. Enable its existing host gates
    // before starting the owned server, keeping all targets on the local DB.
    process.env.MIKKA_BYOS_ENABLED = '1'
    process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
  }
  const origin = process.env.LOCAL_LOOP_ORIGIN ?? `http://localhost:${process.env.MIKKA_DEV_PORT ?? '3110'}`
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Only loopback app targets are allowed')
  const driverRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  // An attached runner can contain reviewed harness changes. Bind auth/DB
  // attestation to the existing server's descriptor, recording driver code
  // separately; bootstrap and account acquisition still verify that binding.
  const previous = process.env.MIKKA_TEST_ENVIRONMENT_FILE ? await readFile(process.env.MIKKA_TEST_ENVIRONMENT_FILE, 'utf8').then(JSON.parse, () => null) : null
  if (existing) assert.ok(previous, '--existing requires the owning environment descriptor')
  const revision = existing ? previous.deploymentSha : driverRevision
  assert.match(revision, /^[a-f0-9]{40}$/, 'The owning server revision must be immutable')
  sourceFingerprint = await fingerprint()
  if (!existing) {
    const source = new URL(process.env.E2E_DATABASE_URL)
    secrets.add(decodeURIComponent(source.password))
    const databaseName = `mikka_loop_${runId.replaceAll('-', '').slice(0, 12)}_e2e`
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
    const admin = new pg.Pool({ connectionString: adminUrl.href, max: 1 })
    try { await admin.query(`CREATE DATABASE "${databaseName}"`) } finally { await admin.end() }
    source.pathname = `/${databaseName}`
    for (const key of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) process.env[key] = source.href
    delete process.env.ORVILO_DATABASE_URL
    process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('base64url')
    secrets.add(process.env.BETTER_AUTH_SECRET)
    process.env.MIKKA_DEV_PORT = new URL(origin).port
    process.env.MIKKA_DEV_DAEMON_DIR = join(directory, 'daemon')
    await step('migrate', 180_000, () => command(['--import', 'tsx', 'scripts/setup-e2e-db.mjs']))
  }
  process.env.BETTER_AUTH_URL = origin
  process.env.E2E_BASE_URL = origin
  process.env.MIKKA_TEST_DEPLOYMENT_SHA = revision
  process.env.MIKKA_TEST_ENVIRONMENT_FILE ||= join(directory, 'environment.json')
  pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3, statement_timeout: 10_000, connectionTimeoutMillis: 5_000 })
  // Existing mode can reuse a previously bootstrapped descriptor; a fresh DB
  // can be adopted only before any account exists, as enforced by bootstrap.
  environment = await bootstrapEnvironment({ connectionString: process.env.E2E_DATABASE_URL, origin, deploymentSha: revision, id: previous?.id ?? `local-loop-${runId}`, outputFile: process.env.MIKKA_TEST_ENVIRONMENT_FILE,
    authorizeDatabase: async (database, descriptor) => {
      assert.equal((await database.query('SELECT current_database() AS name')).rows[0].name, descriptor.database.name)
      assert.ok(descriptor.database.name.endsWith('_e2e'))
    },
  })
  if (!existing || process.env.BETTER_AUTH_SECRET) await recordRunnerEvidenceSecrets(environment)
  else {
    // An attached runner never reads the server process's auth secret. It does
    // not retain that server's raw output, and audits only credentials it owns.
    await recordAuthenticationSecrets([decodeURIComponent(new URL(process.env.E2E_DATABASE_URL).password)], { environment })
  }
  await new TestAccountPool(pool, environment).prepare({ pairs: 4 })
  if (!existing) child(process.execPath, ['scripts/dev-local.mjs'], { ...process.env, NEXT_TELEMETRY_DISABLED: '1', MIKKA_DEV_SKIP_ENV_FILES: '1', ...(!needsDaemon ? { MIKKA_DEV_SKIP_DAEMON: '1' } : {}) }, true)
  await step('server-ready', 180_000, signal => until(signal, async () => {
    try { return (await fetch(`${origin}/mikka/sign-in`, { signal: AbortSignal.timeout(5_000) })).ok } catch { return false }
  }))
  // Compile the authenticated page's route before the account helper's bounded
  // initialization request. Anonymous requests still compile Next's route before
  // it resolves auth and redirects; no session or guard timeout is changed.
  await step('server-shell-warmup', 180_000, async signal => {
    await until(signal, async () => {
      try { return (await fetch(`${origin}/mikka/zh-CN`, { signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) })).ok } catch { return false }
    })
  })
  accounts = await step('account-lease', 120_000, () => acquireTestAccounts({ environment, database: pool, runId, workerId: 'local-loop', requestId: runId }))
  await step('local-account-ready', 120_000, signal => until(signal, async () => {
    const refreshed = await fetch('http://127.0.0.1:3191/refresh', { method: 'POST', signal: AbortSignal.timeout(90_000) })
    if (!refreshed.ok) return false
    const keys = await query(`SELECT id FROM model_api_keys WHERE "ownerId"=$1 AND provider='deepseek'`, [accounts.owner.userId])
    assert.ok(keys.length, 'No real DeepSeek key seeded; refusing scripted/default model acceptance')
    return true
  }))
  runtime = await step('runtime-ready', 120_000, signal => until(signal, async () => {
    try {
      const review = existing && process.env.LOCAL_LOOP_LOCAL_EVIDENCE_FILE ? JSON.parse(await readFile(process.env.LOCAL_LOOP_LOCAL_EVIDENCE_FILE, 'utf8')) : null
      const value = JSON.parse(await readFile(resolve(review?.repositoryRoot ?? root, '.cache/dev-local/runtime.json'), 'utf8'))
      return (existing || value.daemonDataDir === process.env.MIKKA_DEV_DAEMON_DIR) ? value : null
    } catch { return null }
  }))
  assert.equal(new URL(runtime.server ?? runtime.appUrl).origin, origin, 'runtime origin mismatch')
  if (!needsDaemon) {
    await writeFile(join(directory, 'environment-summary.json'), JSON.stringify({ revision, driverRevision, sourceFingerprint, items: selectedItems, origin, database: environment.database.name, instanceId: environment.instanceId, leaseId: accounts.lease.id, started: new Date(started).toISOString(), externalBoundaries: ['Real DeepSeek model', 'No daemon required by selected items', 'No browser tests', 'No production DB writes'] }, null, 2), { mode: 0o600 })
    return null
  }
  const standaloneDaemon = (args, persistent = false) => {
    const config = join(directory, 'daemon.gitconfig')
    const env = { ...process.env, MIKKA_TEST_MODE: '1', MIKKA_DEV_GIT_ORIGIN: runtime.scenario.barePath, GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' }
    const tsx = join(root, 'packages/daemon/node_modules/.bin/tsx')
    return child(tsx, [join(root, 'packages/daemon/bin/mikka.ts'), ...args], env, persistent)
  }
  if (existing) {
    // A new lease has a different owner. Reusing another account's device
    // credential would defeat the account-pool boundary, so log in our own CLI.
    await writeFile(join(directory, 'daemon.gitconfig'), `[url "${pathToFileURL(runtime.scenario.barePath).href}"]\n\tinsteadOf = https://github.com/mikka-e2e/core-loop.git\n[protocol "file"]\n\tallow = always\n`, { mode: 0o600 })
    daemonCode = undefined
    standaloneDaemon(['daemon', 'login', '--server', runtime.server, '--data-dir', join(directory, 'daemon')])
  }
  await step('device-login', 60_000, async signal => {
    const code = await until(signal, () => daemonCode)
    await json(accounts.owner, `/api/auth/device?user_code=${encodeURIComponent(code)}`)
    await json(accounts.owner, '/api/auth/device/approve', { userCode: code })
  })
  if (existing) {
    await step('device-credential-ready', 30_000, signal => until(signal, () => access(join(directory, 'daemon/device.json')).then(() => true, () => false)))
    standaloneDaemon(['daemon', '--no-auto-update', '--server', runtime.server, '--data-dir', join(directory, 'daemon')], true)
  }
  const devices = await step('daemon-ready', 60_000, signal => until(signal, async () => {
    const result = await json(accounts.owner, '/api/mobile/threads')
    return result.devices?.some(device => device.online) ? result.devices : null
  }))
  const device = devices.find(value => value.online)
  await writeFile(join(directory, 'environment-summary.json'), JSON.stringify({ revision, driverRevision, sourceFingerprint, origin, database: environment.database.name, instanceId: environment.instanceId, leaseId: accounts.lease.id, deviceId: device.id, started: new Date(started).toISOString(), externalBoundaries: ['Real DeepSeek model', 'Synthetic GitHub API and real local bare Git push', 'No browser tests', 'No production DB writes'] }, null, 2), { mode: 0o600 })
  return device
}

async function accept(device) {
  const only = selectedItems
  const failures = []
  const check = async (...args) => { try { const result = await step(...args); completedItems.push(Number(/^item(\d+)/.exec(args[0])[1])); return result } catch (error) { failures.push(error) } }
  const repo = 'https://github.com/mikka-e2e/core-loop.git'
  if (only.includes('1')) await check('item1-core-loop', 600_000, async signal => {
    const id = await dispatch('item1', `创建一个新任务，在本机 ${device.name}（设备ID ${device.id}）用 Claude Code 修改 ${repo}。在 README.md 追加一行 local acceptance ${runId}，提交并开 PR。任务描述完整保留验收标记。`, signal)
    const done = await terminal(id, signal)
    assert.equal(done.status, 'succeeded', redact(done.error ?? 'run did not succeed'))
    const published = await until(signal, async () => { const current = await run(id); return current.publication === 'published' && current.pullRequest ? current : null })
    const evidence = await observations()
    assert.ok(evidence.pullRequests.some(pr => pr.url === published.pullRequest.url), 'Synthetic GitHub did not confirm PR')
    assert.ok(done.report?.publish?.pushed, 'Run did not push a commit')
    const commit = execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show', `${done.report.publish.commit}:README.md`], { encoding: 'utf8' })
    assert.ok(commit.includes(runId), 'Remote pushed tree lacks the acceptance marker')
    await until(signal, async () => JSON.stringify(await json(accounts.owner, '/api/coordinator/messages')).includes(published.pullRequest.url))
    await progress('item1-core-loop', 'evidence', id)
  })
  if (only.includes('2')) await check('item2-read-only', 600_000, async signal => {
    const before = await observations()
    const refs = execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show-ref'], { encoding: 'utf8' })
    const id = await dispatch('item2', `创建新任务，仅以 readOnly:true 派发给本机 ${device.name}（设备ID ${device.id}），仓库 ${repo}。检查 README 并报告，不要修改、提交或push。不得申请写权限或改为可写任务。任务描述完整保留验收标记。`, signal)
    const done = await terminal(id, signal)
    assert.equal(done.agentDefinition?.readOnly, true, 'Dispatch did not freeze readOnly')
    assert.equal(done.status, 'succeeded', redact(done.error ?? 'Read-only model run did not complete normally'))
    assert.ok(!done.report?.publish?.pushed && !done.pullRequest, 'Read-only run published')
    assert.equal(execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show-ref'], { encoding: 'utf8' }), refs, 'Read-only run changed remote refs')
    assert.equal((await observations()).pullRequests.length, before.pullRequests.length)
    await progress('item2-read-only', 'evidence', id)
  })
  if (only.includes('3')) await check('item3-failure-stage', 240_000, async signal => {
    // Fault-inject only our fixture's bare origin, preserving its contents and
    // restoring it even on failure. This produces a real daemon fetch failure
    // without waiting for network failures or changing run rows in the DB.
    const unavailable = `${runtime.scenario.barePath}.unavailable-${runId}`
    await rename(runtime.scenario.barePath, unavailable)
    try {
      const id = await dispatch('item3', `创建新任务，以 readOnly:true 派发给本机 ${device.name}（设备ID ${device.id}）检查仓库 ${repo}。读取 README 并报告，不要替换仓库重试。任务描述完整保留验收标记。`, signal)
      const done = await terminal(id, signal)
      assert.equal(done.status, 'failed', 'Unavailable fixture repository should fail')
      assert.ok(done.error?.trim(), 'Failure reason missing')
      const view = await json(accounts.owner, `/api/mobile/threads/${id}`)
      assert.equal(view.error, done.error, 'Thread API lost the failure reason')
      assert.ok(view.items.some(item => item.kind === 'stages' && item.stages.some(stage => stage.stage === 'repository' && stage.ok === false)), 'Thread has no failed repository startup stage')
      assert.match(done.error, /clone|fetch|repository|仓库|not found|does not exist/i, 'Failure reason does not describe the repository failure')
      await progress('item3-failure-stage', 'scope', 'HTTP thread projection preserves the repository failure and its stage; visual placement is not browser-tested')
      await progress('item3-failure-stage', 'evidence', id)
    } finally { await rename(unavailable, runtime.scenario.barePath) }
  })
  if (only.includes('4')) await check('item4-agent-communication', 240_000, async signal => {
    const workspace = (await json(accounts.owner, '/api/workspace')).workspace.id
    const first = await json(accounts.owner, '/api/mobile/bots', { name: `Sender ${runId.slice(0, 8)}`, color: 'bleu', shape: 'cercle' })
    const second = await json(accounts.owner, '/api/mobile/bots', { name: `Receiver ${runId.slice(0, 8)}`, color: 'vert', shape: 'cercle' })
    const refreshed = await fetch('http://127.0.0.1:3191/refresh', { method: 'POST', signal })
    assert.ok(refreshed.ok, 'Could not seed the new bots with the real DeepSeek selection')
    const group = await json(accounts.owner, '/api/conversations', { workspaceId: workspace, title: `Communication ${runId}`, leadBotId: first.id, members: [first, second].map(bot => ({ memberType: 'bot', memberId: bot.id })) })
    await json(accounts.owner, `/api/conversations/${group.id}/messages`, { body: `请 ${first.name} 先发送短消息“交接 ${runId}”，并在回复的mentions中邀请当前成员 ${second.id} 回答。请 ${second.name} 在读到对方消息后回复“收到 ${runId}”。这是两位Agent互相传话的验收。`, mentions: [{ memberType: 'bot', memberId: first.id }] })
    const view = await until(signal, async () => {
      const value = await json(accounts.owner, `/api/conversations/${group.id}/messages`)
      const failed = (await query('SELECT error FROM group_turns WHERE "conversationId"=$1 AND status=\'failed\' ORDER BY "createdAt" DESC LIMIT 1', [group.id]))[0]
      if (failed) throw new Error(`Group generation failed: ${failed.error}`)
      if (value.routingError) throw new Error(`Group routing failed: ${value.routingError.code}`)
      return value.messages.some(message => message.authorId === first.id && message.body.includes(runId)) && value.messages.some(message => message.authorId === second.id && message.body.includes(runId)) ? value : null
    })
    const ordered = [...view.messages].sort((a, b) => Number(BigInt(a.position) - BigInt(b.position)))
    const sender = ordered.find(message => message.authorId === first.id)
    const receiver = ordered.find(message => message.authorId === second.id)
    assert.ok(BigInt(receiver.position) > BigInt(sender.position), 'Reply preceded the peer message')
    assert.ok(sender.mentions.some(mention => mention.memberId === second.id), 'Sender did not address the peer')
    const peerAccess = await accounts.peer.request(`/api/conversations/${group.id}/messages`)
    assert.equal(peerAccess.status, 404, 'Unrelated identity could read Agent communication')
    await progress('item4-agent-communication', 'evidence', group.id)
  })
  if (only.includes('5')) await check('item5-inbox', 90_000, async signal => {
    let issue = (await query('SELECT id FROM issues WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1', [accounts.owner.userId]))[0]
    if (!issue) {
      const title = `Inbox ${runId}`
      await json(accounts.owner, '/api/coordinator/messages', { text: `请只创建一个标题为“${title}”的个人任务，描述为“收件箱验收”。不要派发、不要启动线程、不要调用任何电脑。`, submissionId: randomUUID() })
      issue = await until(signal, async () => (await query('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [accounts.owner.userId, title]))[0])
    }
    // The web inbox is the subscribed task list. Exercise its real preference
    // action through a CLI, rather than seed subscription metadata in SQL.
    await command(['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'scripts/dev-local/inbox-check.mjs', accounts.owner.userId, accounts.peer.userId, issue.id])
    const response = await json(accounts.owner, '/api/mobile/tasks')
    assert.ok(response.tasks.some(task => task.id === issue.id), 'Subscribed task is not visible through authenticated task API')
    const foreign = await accounts.peer.request('/api/mobile/tasks', { signal })
    assert.ok(foreign.ok)
    assert.ok(!(await foreign.json()).tasks.some(task => task.id === issue.id), 'Foreign task leaked to peer inbox')
    await progress('item5-inbox', 'evidence', issue.id)
  })
  if (only.includes('6')) await check('item6-agent-mailbox', 600_000, signal => verifyMailbox({ accounts, pool, progress, signal }))
  if (only.includes('7')) await check('item7-worker-mailbox', 600_000, signal => verifyWorkerMailbox({ accounts, pool, progress, signal, device }))
  if (only.includes('8')) await check('item8-cloud-loop', 900_000, async signal => {
    const reviewed = process.env.LOCAL_LOOP_LOCAL_EVIDENCE_FILE
      ? await (await import('./reviewed-local-evidence.mjs')).verifyReviewedLocalEvidence(process.env.LOCAL_LOOP_LOCAL_EVIDENCE_FILE, { environment, runtime }) : null
    const previous = process.env.LOCAL_LOOP_LOCAL_PASS_EVIDENCE ? JSON.parse(await readFile(process.env.LOCAL_LOOP_LOCAL_PASS_EVIDENCE, 'utf8')) : null
    if (previous) {
      assert.equal(previous.sourceFingerprint, sourceFingerprint, 'Cloud prerequisite evidence is for different source code')
      assert.equal(previous.fixedSource, true, 'Cloud prerequisite evidence was not a fixed-source run')
    }
    const passed = new Set([...completedItems, ...(previous?.passedItems ?? []), ...(reviewed?.passedItems ?? [])])
    assert.ok([1, 2, 3, 4, 5, 6, 7].every(item => passed.has(item)), 'Run and pass the local five items and native/worker mailbox before the paid cloud leg')
    const metadata = await readFile(process.env.LOCAL_LOOP_CLOUD_TEMPLATE_FILE ?? '/tmp/mikka-e2b-services-build-result.json', 'utf8').then(JSON.parse, () => ({}))
    const templateId = process.env.E2B_ACCEPTANCE_TEMPLATE ?? metadata.templateId
    const workerHash = process.env.E2B_WORKER_SHA ?? metadata.workerHash
    assert.match(templateId ?? '', /^[A-Za-z0-9_-]+$/, 'A private acceptance E2B template is required')
    assert.match(workerHash ?? '', /^[a-f0-9]{40}$/, 'The acceptance template worker source hash is required')
    const { verifyCloud } = await import('../e2b/cloud-local-acceptance.mjs')
    await verifyCloud({ environment, progress, signal, templateId, workerHash, runtime, accounts, pool })
  })
  if (failures.length) throw new AggregateError(failures, `${failures.length} acceptance item(s) failed`)
}

async function cleanup() {
  return cleanupPromise ??= (async () => {
    try {
      if (accounts) {
        const tokens = await json(accounts.owner, '/api/device-tokens')
        for (const token of tokens.tokens ?? []) if (!token.revokedAt) await json(accounts.owner, `/api/device-tokens/${token.id}/revoke`, {}, 'POST')
      }
    } catch { await progress('cleanup', 'warning', 'Device revocation could not be confirmed; disposable environment retained') }
    for (const processChild of children.reverse()) {
      if (!processChild.pid || processChild.exitCode !== null || processChild.signalCode !== null) continue
      const exited = new Promise(done => processChild.once('exit', done))
      try { process.kill(-processChild.pid, 'SIGTERM') } catch { continue }
      const terminated = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])
      if (!terminated) { try { process.kill(-processChild.pid, 'SIGKILL') } catch { /* Already stopped. */ } }
    }
    await accounts?.release({ outcome: 'dirty' })
    await pool?.end()
    // Only the daemon credential files created by this invocation are removed;
    // repository worktrees and non-secret evidence remain inspectable.
    for (const name of ['device.json', 'daemon.secret']) await rm(join(directory, 'daemon', name), { force: true }).catch(() => {})
  })()
}

process.once('SIGINT', () => { interrupted = true; releaseHold?.(); void cleanup() })
process.once('SIGTERM', () => { interrupted = true; releaseHold?.(); void cleanup() })
try {
  await mkdir(resolve(root, '.cache/dev-local'), { recursive: true, mode: 0o700 })
  const device = await setup()
  await accept(device)
  const finishedFingerprint = await fingerprint()
  await writeFile(join(directory, 'source-evidence.json'), JSON.stringify({ startedFingerprint: sourceFingerprint, finishedFingerprint, fixedSource: finishedFingerprint === sourceFingerprint }, null, 2), { mode: 0o600 })
  assert.equal(finishedFingerprint, sourceFingerprint, 'Runtime source changed during acceptance; rerun on the final fixed code')
  await writeFile(join(directory, 'passed-items.json'), JSON.stringify({ runId, sourceFingerprint, fixedSource: true, passedItems: completedItems, selectedItems, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  await progress('acceptance', 'ok', `selected items: ${selectedItems.join(',')}`)
  if (process.env.LOCAL_LOOP_HOLD === '1') {
    await accounts.assertActive()
    await progress('service-hold', 'start', 'Owned services and renewable account lease retained until SIGINT or SIGTERM')
    let timer, unsubscribe
    try {
      await new Promise((resolve, reject) => {
        releaseHold = resolve
        unsubscribe = accounts.onLeaseLost(() => reject(new Error('Account lease lost while holding services')))
        timer = setInterval(() => {
          if (serviceFailure) reject(serviceFailure)
          else void progress('service-hold', 'heartbeat')
        }, 15_000)
      })
    } finally { clearInterval(timer); unsubscribe?.(); releaseHold = undefined }
  }
} catch (error) {
  await progress('acceptance', 'fail', error.message)
  await writeFile(join(directory, 'failure-tail.log'), redact(output), { mode: 0o600 }).catch(() => {})
  console.error(`Acceptance failed during ${activeStep ?? 'setup'}; redacted logs: ${join(directory, 'failure-tail.log')}`)
  process.exitCode = 1
} finally { await cleanup() }
