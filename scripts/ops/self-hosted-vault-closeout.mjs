import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { sourceGuard, workflowGuard } from './self-hosted-closeout.mjs'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

const plan = JSON.parse(await readFile(new URL('./self-hosted-closeout-plan.json', import.meta.url), 'utf8'))
const check = (value, code) => { if (!value) throw new Error(code) }
const digest = value => createHash('sha256').update(value).digest('hex')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function ownedMachine(row, actor, metadata) {
  check(row?.ownerId === actor.userId && row?.workspaceId === actor.workspaceId
    && /^[a-z0-9]{10,64}$/.test(row?.sandboxId ?? '') && uuid.test(row?.operationId ?? ''), 'MACHINE_ROW')
  check(metadata?.application === 'mikka' && metadata?.workspaceId === actor.workspaceId, 'MACHINE_METADATA')
  return row.sandboxId
}
export function ownHttps(value) {
  const u = new URL(value)
  check(u.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(u.hostname)
    && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'FIXTURE_ORIGIN')
  return u.origin
}
export function loginMatches(body, username, password) {
  const form = new URLSearchParams(body)
  if (form.getAll('username').length !== 1 || form.getAll('password').length !== 1) return false
  const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
  return same(form.get('username'), username) && same(form.get('password'), password)
}

async function candidateGuard(env) {
  workflowGuard(env)
  check(/^[a-f0-9]{40}$/.test(plan.gatewayCandidateSource ?? ''), 'CANDIDATE_SOURCE')
  const paths = ['scripts/e2b/subagent-gateway.py', 'scripts/e2b/subagent-cdp.mjs']
  check(JSON.stringify(Object.keys(plan.gatewayCandidateFiles ?? {}).sort()) === JSON.stringify(paths.sort()), 'CANDIDATE_PATHS')
  for (const path of paths) {
    const response = await fetch(`https://api.github.com/repos/${plan.repository}/contents/${path}?ref=${plan.gatewayCandidateSource}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      redirect: 'error', signal: AbortSignal.timeout(20_000) })
    check(response.ok, 'CANDIDATE_FILE')
    const file = await response.json()
    check(file.type === 'file' && file.encoding === 'base64' && file.size > 0 && file.size < 262_144, 'CANDIDATE_FILE')
    check(digest(Buffer.from(file.content, 'base64')) === plan.gatewayCandidateFiles[path]
      && digest(await readFile(resolve(path))) === plan.gatewayCandidateFiles[path], 'CANDIDATE_DIGEST')
  }
}

async function run(env) {
  await sourceGuard(env)
  await candidateGuard(env)
  check(/^[a-f0-9]{40}$/.test(plan.workerHash ?? ''), 'WORKER_SOURCE_PIN')
  check(env.E2B_API_KEY && env.RUNNER_TEMP, 'WORKLOAD_KEY')
  const { Sandbox, SandboxNotFoundError } = await import('e2b')
  const { Pool } = await import('pg')
  const { request } = await import('@playwright/test')
  const output = resolve('.artifacts/self-hosted-vault')
  const root = join(env.RUNNER_TEMP, `mikka-vault-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`)
  await mkdir(root, { mode: 0o700 }); await mkdir(output, { recursive: true })
  const report = { source: plan.source, imageDigest: plan.imageDigest, driver: env.GITHUB_SHA,
    started: new Date().toISOString(), stage: 'fixture', checks: {}, cleanup: {}, productionOAuth: false,
    realE2B: true, modelCalls: 0, scope: 'real-subagent-workflow-and-in-process-local-kms-broker' }
  report.runtimeCandidate = { source: plan.gatewayCandidateSource, files: plan.gatewayCandidateFiles,
    readOnlyScriptMounts: true, fullFinalImageAcceptance: false }
  const dbPassword = randomBytes(24).toString('hex'), accountPassword = randomBytes(24).toString('base64url')
  const masterKey = randomBytes(32).toString('base64'), secretsKey = randomBytes(32).toString('hex')
  const siteUsername = randomBytes(18).toString('base64url'), sitePassword = randomBytes(32).toString('base64url')
  const email = `vault-${randomUUID()}@selfhost.example.test`
  const hidden = [dbPassword, accountPassword, masterKey, secretsKey, sitePassword, env.E2B_API_KEY]
  for (const value of hidden) console.log(`::add-mask::${value}`)
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
  const composePath = join(root, 'compose.json'), project = `vault-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  const compose = (...args) => docker('compose', '-f', composePath, '-p', project, ...args)
  let context, pool, actor, botId, subagentId, credentialId, interrupted = false, cleaning = false
  let fixtureStarted = false, appOrigin, siteOrigin, submitted = 0, rejected = 0, servedLogin = 0, authenticatedViews = 0
  let submissionResolve
  const submission = new Promise(resolveSubmission => { submissionResolve = resolveSubmission })
  const tunnels = []
  const signal = () => { interrupted = true; process.exitCode = 1 }
  process.once('SIGTERM', signal); process.once('SIGINT', signal)
  const json = async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' }); check(r.ok, 'FIXTURE_HTTP'); return r.json()
  }
  const api = async (path, body, statuses = [200], method = body ? 'POST' : 'GET') => {
    check(!interrupted || cleaning, 'INTERRUPTED')
    check(path.startsWith('/api/'), 'API_PATH')
    const r = await context.fetch(appOrigin + '/mikka' + path, { method, timeout: 60_000,
      ...(body ? { data: body, headers: { Origin: appOrigin, ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) } } : {}) })
    check(statuses.includes(r.status()), `LOCAL_HTTP_${r.status()}`)
    return r.json()
  }
  const rpc = async (action, args) => {
    check(['workspace-secrets.saveE2BKey', 'workspace-secrets.deleteE2BKey', 'settings-activity.saveSavedLogin',
      'settings-activity.listSavedLogins', 'settings-activity.listSavedLoginUsage', 'settings-activity.deleteSavedLogin',
      'coordinator.setBotActive'].includes(action), 'RPC_ACTION')
    const wire = await api('/api/rpc', { version: DESKTOP_RPC_VERSION, action, args: encode(args) })
    check(wire.ok === true && wire.version === DESKTOP_RPC_VERSION, 'RPC_WIRE')
    const result = decode(wire.result); check(result && !result.error, 'RPC_RESULT'); return result.data ?? result
  }
  const site = createServer(async (req, res) => {
    // This owned site receives a random disposable credential. It never echoes,
    // logs, retains request bodies or makes an outbound request.
    if (req.url === '/health') { res.writeHead(200); res.end('ready'); return }
    if (req.method === 'POST' && req.url === '/login') {
      let body = '', oversized = false
      for await (const chunk of req) { if (body.length + chunk.length > 8192) oversized = true; else body += chunk }
      const valid = !oversized && loginMatches(body, siteUsername, sitePassword); body = ''
      if (valid) {
        submitted++
        res.writeHead(303, { location: '/success', 'set-cookie': 'vault_acceptance=verified; HttpOnly; Secure; SameSite=Lax; Path=/', 'cache-control': 'no-store' })
        res.end(); return
      }
      rejected++; res.writeHead(403); res.end('refused'); return
    }
    if (req.url === '/success' && /(?:^|; )vault_acceptance=verified(?:;|$)/.test(req.headers.cookie ?? '')) {
      authenticatedViews++; submissionResolve()
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>Vault acceptance complete</title><h1>Signed in</h1>'); return
    }
    servedLogin++
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end('<!doctype html><html><head><title>Owned login fixture</title></head><body><form method="post" action="/login"><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form></body></html>')
  })
  const tunnel = async port => {
    const child = spawn(join(env.RUNNER_TEMP, 'cloudflared'), ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { env: { PATH: env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] })
    tunnels.push(child)
    return new Promise((accept, reject) => {
      let buffer = ''; const timer = setTimeout(() => reject(new Error('TUNNEL_TIMEOUT')), 45_000)
      child.stderr.on('data', data => { buffer = (buffer + data).slice(-20_000); const found = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (found) { clearTimeout(timer); accept(ownHttps(found[0])) } })
      child.once('error', () => { clearTimeout(timer); reject(new Error('TUNNEL_START')) })
    })
  }
  try {
    appOrigin = await tunnel(3000); siteOrigin = await tunnel(3049)
    await new Promise(resolveListening => site.listen(3049, '127.0.0.1', resolveListening))
    const database = `postgres://mikka:${dbPassword}@postgres:5432/mikka_e2e`
    const fixture = { services: {
      postgres: { image: 'postgres:17-alpine', environment: { POSTGRES_DB: 'mikka_e2e', POSTGRES_USER: 'mikka', POSTGRES_PASSWORD: dbPassword },
        ports: ['127.0.0.1:54329:5432'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U mikka -d mikka_e2e'], interval: '3s', timeout: '3s', retries: 30 } },
      mailpit: { image: 'axllent/mailpit:v1.27.4', ports: ['127.0.0.1:8025:8025'], environment: { MP_DISABLE_VERSION_CHECK: 'true', MP_QUIET: 'true' } },
      app: { image: `ghcr.io/alexj11324/mikka@${plan.imageDigest}`, init: true, ports: ['127.0.0.1:3000:3000'], volumes: ['data:/data', `${resolve('scripts/ops/vault-runtime-diagnostics.mjs')}:/opt/closeout/vault-runtime-diagnostics.mjs:ro`],
        environment: { DATABASE_URL: database, MIKKA_DATABASE_URL: database, BETTER_AUTH_URL: appOrigin,
          MIKKA_VAULT_DIAGNOSTICS: '1', NODE_OPTIONS: '--import=/opt/closeout/vault-runtime-diagnostics.mjs',
          MIKKA_CLOUD_WORKER_SOURCE_COMMIT: plan.source, MIKKA_CLOUD_WORKER_SHA: plan.workerHash,
          MIKKA_EDITION: 'community', MIKKA_EXTERNAL_CRON: '1', CREDENTIAL_MASTER_KEY: masterKey, WORKSPACE_SECRETS_KEY: secretsKey,
          SMTP_URL: 'smtp://mailpit:1025', MIKKA_EMAIL_FROM: 'Vault acceptance <login@selfhost.example.test>' },
        depends_on: { postgres: { condition: 'service_healthy' }, mailpit: { condition: 'service_started' } } }
    }, volumes: { data: {} } }
    for (const path of Object.keys(plan.gatewayCandidateFiles)) fixture.services.app.volumes.push(`${resolve(path)}:/app/${path}:ro`)
    await writeFile(composePath, JSON.stringify(fixture), { mode: 0o600 }); fixtureStarted = true
    const image = JSON.parse(docker('image', 'inspect', `ghcr.io/alexj11324/mikka@${plan.imageDigest}`))[0]
    const imageEnv = Object.fromEntries((image.Config?.Env ?? []).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)] }))
    report.runtimeSetup = { imageSourcePinPresent: !!imageEnv.MIKKA_CLOUD_WORKER_SOURCE_COMMIT,
      imageWorkerPinPresent: !!imageEnv.MIKKA_CLOUD_WORKER_SHA, operatorConfiguredPins: true,
      source: plan.source, workerHash: plan.workerHash, template: 'desktop' }
    compose('up', '--detach', '--wait', '--wait-timeout', '240')
    for (let i = 0; ; i++) {
      try { check((await json(appOrigin + '/mikka/api/version')).build === plan.source, 'IMAGE_SOURCE'); break }
      catch { check(i < 30 && !interrupted, 'IMAGE_READY'); await delay(1000) }
    }
    context = await request.newContext({ timeout: 60_000 })
    await api('/api/auth/sign-up/email', { name: 'Vault acceptance', email, password: accountPassword }, [200, 201])
    let message
    for (let i = 0; i < 25 && !message; i++) {
      const list = await json('http://127.0.0.1:8025/api/v1/messages')
      const found = list.messages?.find(m => m.To?.some(to => to.Address === email))
      if (found) message = await json(`http://127.0.0.1:8025/api/v1/message/${found.ID}`); else await delay(400)
    }
    const verify = String(message?.Text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mikka\/api\/auth\/verify-email\?[^\s]+/)?.[0]
    check(verify && new URL(verify).origin === appOrigin, 'VERIFY_ORIGIN')
    check((await context.get(verify, { maxRedirects: 0 })).status() === 302, 'VERIFIED')
    await api('/api/auth/sign-in/email', { email, password: accountPassword })
    const session = await api('/api/auth/get-session'), workspace = await api('/api/workspace')
    check(session.user?.emailVerified && uuid.test(workspace.workspace?.id), 'LOCAL_IDENTITY')
    actor = { userId: session.user.id, workspaceId: workspace.workspace.id }
    report.checks.emailVerified = true
    report.actorHash = digest(actor.userId).slice(0, 16); report.workspaceHash = digest(actor.workspaceId).slice(0, 16)
    pool = new Pool({ connectionString: `postgres://mikka:${dbPassword}@127.0.0.1:54329/mikka_e2e` })
    report.stage = 'save-key-and-login'
    check((await rpc('workspace-secrets.saveE2BKey', [{ apiKey: env.E2B_API_KEY }, actor.workspaceId])).configured === true, 'E2B_KEY_SAVED')
    const saved = await rpc('settings-activity.saveSavedLogin', [{ site: siteOrigin, account: siteUsername, password: sitePassword }])
    check(uuid.test(saved.id) && saved.site === siteOrigin, 'LOGIN_SAVED'); credentialId = saved.id
    const encrypted = (await pool.query('SELECT s.wrapped_dek,s.ciphertext FROM credential_secrets s JOIN credentials c ON c.id=s.credential_id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3', [credentialId, actor.userId, siteOrigin])).rows
    check(encrypted.length === 1 && encrypted[0].wrapped_dek.startsWith('local:v1:') && !encrypted[0].ciphertext.includes(sitePassword), 'LOCAL_ENVELOPE')
    report.checks.localEnvelopeEncrypted = true
    const logins = await rpc('settings-activity.listSavedLogins', [])
    check(logins.logins.length === 1 && logins.logins[0].id === credentialId && !JSON.stringify(logins).includes(sitePassword), 'LOGIN_READ_REDACTED')
    report.checks.listReturnsNoPassword = true
    const bot = await api('/api/bots', { name: `Vault closeout ${env.GITHUB_RUN_ID}` }, [201]); botId = bot.id
    check(uuid.test(botId) && bot.workspaceId === actor.workspaceId, 'BOT_OWNER')
    report.stage = 'real-agent-workflow'
    const started = await api(`/api/bots/${botId}/subagents`, { task: `Sign in to ${siteOrigin}/login using the saved website login. Stop after the site confirms sign-in.` }, [202])
    check(uuid.test(started.subagentId), 'SUBAGENT_ID'); subagentId = started.subagentId
    // The actual Workflow provisions/navigates/observes and requests the saved
    // login itself. No SQL state, guard, CDP, broker or model output is injected.
    let deadline
    try { await Promise.race([submission, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('AUTOFILL_TIMEOUT')), 360_000) })]) }
    finally { clearTimeout(deadline) }
    check(!interrupted && submitted === 1 && rejected === 0 && servedLogin > 0, 'FORM_SUBMITTED')
    report.checks.realSiteSubmitted = true
    await api(`/api/bots/${botId}/subagents/${subagentId}/stop`, {})
    report.checks.normalAgentStop = true
    const uses = await rpc('settings-activity.listSavedLoginUsage', [credentialId])
    check(uses.uses.some(use => use.subagentId === subagentId && use.botId === botId && use.result === 'input_inserted_guarded'), 'GUARDED_ACCESS_EVENT')
    report.checks.actualGuardedBroker = true
    report.checks.agentAutomaticSavedLogin = true
    report.site = { servedLogin, submitted, rejected, authenticatedViews }
    report.status = 'passed'; report.stage = 'completed'
  } catch (error) {
    report.status = 'failed'; process.exitCode = 1
    report.failure = /^[A-Z][A-Z0-9_]{1,64}$/.test(error.message ?? '') ? error.message : 'VAULT_CLOSEOUT_FAILED'
    report.failureName = /^[A-Za-z][A-Za-z0-9]{0,48}$/.test(error.name ?? '') ? error.name : 'unknown'
    if (pool && actor && subagentId) {
      try {
        const row = (await pool.query('SELECT status,step,needs,"lastFailureCode","consecutiveFailures","targetId","activeActionId" FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4', [subagentId, actor.userId, actor.workspaceId, botId])).rows[0]
        report.agent = row ? { status: ['queued','running','needs_you','done','failed','stopped'].includes(row.status) ? row.status : 'unknown',
          step: ['running','Login required','Signing in','Observe login outcome','Login outcome unknown; secure page retained','Browser service unavailable after bounded retries; progress retained','Credential approval','Computer use is denied'].includes(row.step) ? row.step : 'other',
          needs: ['login','approval'].includes(row.needs?.kind) ? row.needs.kind : null,
          lastFailureCode: ['runtime_unavailable','observation_changed'].includes(row.lastFailureCode) ? row.lastFailureCode : null,
          failures: Number(row.consecutiveFailures), targetBound: !!row.targetId, activeAction: !!row.activeActionId } : null
        const events = (await pool.query('SELECT decision,count(*)::int AS count FROM credential_access_events WHERE credential_id=$1 AND user_id=$2 AND subagent_id=$3 GROUP BY decision', [credentialId, actor.userId, subagentId])).rows
        report.accessEvents = events.filter(e => ['input_inserted_guarded','password_submitted','session_applied','denied_or_failed'].includes(e.decision))
      } catch { report.agentDiagnostic = 'unavailable' }
    }
  } finally {
    cleaning = true
    if (context && botId && subagentId) {
      try { const stopped = await api(`/api/bots/${botId}/subagents/${subagentId}/stop`, {}); check(['stopped', 'done', 'failed'].includes(stopped.state), 'STOP'); report.cleanup.subagent = true }
      catch { report.cleanup.subagent = false; process.exitCode = 1 }
    }
    if (pool && actor) {
      try {
        const rows = (await pool.query('SELECT "ownerId","workspaceId","sandboxId","operationId" FROM cloud_machines WHERE "ownerId"=$1 AND "workspaceId"=$2', [actor.userId, actor.workspaceId])).rows
        check(rows.length <= 1, 'MACHINE_AMBIGUOUS')
        // Provisioning writes the owner row before E2B create. Reconcile that
        // row's unique fixture workspace if a crash preceded recording its ID.
        if (rows.length === 1 && !rows[0].sandboxId) {
          const pages = Sandbox.list({ apiKey: env.E2B_API_KEY,
            query: { metadata: { application: 'mikka', workspaceId: actor.workspaceId }, state: ['running', 'paused'] } })
          const found = []
          while (pages.hasNext) found.push(...await pages.nextItems())
          check(found.length <= 1, 'MACHINE_AMBIGUOUS')
          if (found.length === 1) rows[0].sandboxId = found[0].sandboxId
        }
        for (const row of rows) if (row.sandboxId) {
          const info = await Sandbox.getInfo(row.sandboxId, { apiKey: env.E2B_API_KEY })
          const id = ownedMachine(row, actor, info.metadata)
          report.sandboxHash = digest(id).slice(0, 16)
          if (report.status !== 'passed') {
            try {
              const sandbox = await Sandbox.connect(id, { apiKey: env.E2B_API_KEY })
              const result = await sandbox.commands.run(`python3 - <<'PY'\nimport pathlib,importlib.util,shutil,json,urllib.request\np=pathlib.Path\nr={'workerMarker':p('/opt/mikka/worker-source-sha').is_file(),'gatewayFile':p('/opt/mikka/computer/subagent-gateway.py').is_file(),'aiohttpSystem':importlib.util.find_spec('aiohttp') is not None,'nodeOnPath':shutil.which('node') is not None,'chromiumPath':p('/usr/bin/chromium').exists(),'chromePath':p('/usr/bin/google-chrome').exists(),'privateNode':p('/opt/mikka/runtime/node/bin/node').is_file()}\ntry:\n x=urllib.request.urlopen('http://127.0.0.1:6082/version',timeout=2).read(100).decode();r['gatewayVersionValid']=len(x.strip())==64 and all(c in 'abcdef0123456789' for c in x.strip())\nexcept Exception:r['gatewayVersionValid']=False\nprint(json.dumps(r))\nPY`, { user: 'root', timeoutMs: 8_000 })
              const value = JSON.parse(result.stdout)
              check(Object.keys(value).length === 8 && Object.values(value).every(v => typeof v === 'boolean'), 'RUNTIME_DIAGNOSTIC')
              report.runtimeCapabilities = value
            } catch { report.runtimeCapabilities = { unavailable: true } }
          }
          await Sandbox.kill(id, { apiKey: env.E2B_API_KEY })
          const absent = await Sandbox.getInfo(id, { apiKey: env.E2B_API_KEY }).then(() => false, error => error instanceof SandboxNotFoundError)
          check(absent, 'MACHINE_KILL_UNCONFIRMED')
        }
        report.cleanup.e2bConfirmedMissing = true
      } catch { report.cleanup.e2bConfirmedMissing = false; process.exitCode = 1 }
    }
    if (context && credentialId) {
      try { await rpc('settings-activity.deleteSavedLogin', [credentialId]); check((await rpc('settings-activity.listSavedLogins', [])).logins.length === 0, 'LOGIN_REVOKED'); report.cleanup.login = true }
      catch { report.cleanup.login = false; process.exitCode = 1 }
    }
    if (context && actor) {
      try { await rpc('workspace-secrets.deleteE2BKey', [actor.workspaceId]); report.cleanup.key = true } catch { report.cleanup.key = false; process.exitCode = 1 }
      try { await api('/api/auth/sign-out', {}); check((await api('/api/auth/get-session')) === null, 'SESSION_CLOSED'); report.cleanup.session = true } catch { report.cleanup.session = false; process.exitCode = 1 }
    }
    await context?.dispose(); await pool?.end()
    if (fixtureStarted) {
      try {
        const logs = compose('logs', '--no-color')
        report.runtimeBoundaries = logs.split('\n').flatMap(line => {
          const at = line.indexOf('{"kind":"vault_runtime_boundary"')
          if (at < 0) return []
          try { const value = JSON.parse(line.slice(at)); return value.kind === 'vault_runtime_boundary' ? [value] : [] } catch { return [] }
        }).slice(-40)
        report.checks.logsContainNoPlaintext = hidden.every(value => !logs.includes(value)) && !logs.includes(siteUsername)
        check(report.checks.logsContainNoPlaintext, 'PLAINTEXT_LOG')
      } catch { report.checks.logsContainNoPlaintext = false; process.exitCode = 1 }
      try { compose('down', '--volumes', '--remove-orphans'); report.cleanup.fixture = true } catch { report.cleanup.fixture = false; process.exitCode = 1 }
    }
    site.closeAllConnections(); await new Promise(resolveClosed => site.close(resolveClosed)); report.cleanup.site = true
    for (const child of tunnels) child.kill('SIGTERM')
    report.cleanup.tunnels = true
    process.off('SIGTERM', signal); process.off('SIGINT', signal)
    await rm(root, { recursive: true, force: true }); report.cleanup.privateFiles = true
    report.finished = new Date().toISOString()
    report.site = { servedLogin, submitted, rejected, authenticatedViews }
    if (process.exitCode) report.status = 'failed'
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) { workflowGuard(process.env); await sourceGuard(process.env); await candidateGuard(process.env); console.log('Exact image source, public candidate file digests and workload branch verified before credentials') }
  else await run(process.env)
}
