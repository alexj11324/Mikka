// Separate service acceptance: existing published image, no E2B VM or coding
// subscription retry, no shared card/credit mutation and no compatibility UI.
import { execFile, spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { once, EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { mailpitNotifications } from './self-hosting-subscription-acceptance.mjs'

const base = '50d5c771ecab35b453d0f7a1fb729cad79a3131d'
const revision = '88b144d52d091d7ff566c63fce6e902e33edc59e'
const image = 'ghcr.io/alexj11324/mikka@sha256:96de4972ea7820dca9d7f03d116f8a4589c662ee6a6db9cb33cf8ad0f89ec98e'
const publicOrigin = 'https://app.aspectlylabs.com'
const privateProject = 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc', teamId = 'team_C7lwxVVvnUicFli6112mvxpv'
const prefix = 'ops: inspect private cloud production subscriptions final github webhook 1565 revocation only'
const execute = promisify(execFile), sha = x => createHash('sha256').update(x).digest('hex')
const need = (ok, code) => { if (!ok) throw Error('SERVICES_' + code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const git = (...args) => execFileSync('git', ['-C', process.env.GITHUB_WORKSPACE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const report = { schema: 1, kind: 'real-self-hosted-github-revocation-only', upstreamBusinessRun: 42579532129, startedAt: new Date().toISOString(), imageSource: revision,
  image, codingThreadsRequested: 0, driverVirtualMachines: 0, billingConfigurationWrites: 0, uiOpened: false, cases: {}, cleanup: {}, stage: 'guard', status: 'failed' }
const source = resolve(process.env.RUNNER_TEMP ?? '.', 'mikka-github-source')
let cloud, community, localPool, tunnel, ingress, serverRegistered = false, originalWorkspace, ownerId, appToken
const receipts = [], deliveries = new EventEmitter()
const resources = []
const docker = async args => (await execute('docker', args, { encoding: 'utf8', timeout: 150000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
const safe = error => /^(SERVICES_[A-Z0-9_]+|startup_[a-z0-9_]+|SELF_HOSTED_[A-Z0-9_]+)$/.test(error?.message ?? '') ? error.message : 'SERVICES_OPERATION_FAILED'
async function deployment() {
  const r = await fetch('https://api.vercel.com/v9/projects/' + privateProject + '?teamId=' + teamId,
    { headers: { authorization: 'Bearer ' + process.env.VERCEL_TEAM_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(20000) })
  need(r.ok, 'PRIVATE_METADATA'); const p = await r.json(), d = p.targets?.production
  need(p.id === privateProject && p.accountId === teamId && d?.readyState === 'READY'
    && d.meta?.githubCommitSha === '4b6b116a2ecffc00dd44a0c096c65a3f2329df16', 'PRIVATE_SOURCE')
  const alias = await fetch('https://api.vercel.com/v4/aliases/mikka-cloud.vercel.app?teamId=' + teamId,
    { headers: { authorization: 'Bearer ' + process.env.VERCEL_TEAM_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(20000) })
  need(alias.ok, 'PRIVATE_ALIAS'); const a = await alias.json()
  need((a.projectId ?? a.project?.id) === privateProject && (a.deploymentId ?? a.deployment?.id) === d.id, 'PRIVATE_ALIAS')
  return { id: d.id, source: d.meta.githubCommitSha, state: d.readyState }
}
try {
  const e = process.env, event = JSON.parse(await readFile(e.GITHUB_EVENT_PATH, 'utf8'))
  need(e.GITHUB_ACTIONS === 'true' && e.GITHUB_EVENT_NAME === 'push' && e.GITHUB_ACTOR === 'alexj11324' && e.GITHUB_RUN_ATTEMPT === '1'
    && e.GITHUB_REPOSITORY === 'alexj11324/Mikka' && e.GITHUB_REPOSITORY_ID === '1427517699' && e.GITHUB_REPOSITORY_OWNER_ID === '183887963'
    && e.GITHUB_REF === 'refs/heads/ops/infisical-cloud-capabilities', 'EXECUTION')
  need(event.after === e.GITHUB_SHA && !event.deleted && !event.forced && event.head_commit?.message?.startsWith(prefix)
    && event.repository?.id === 1427517699 && event.repository.owner?.id === 183887963 && event.repository.fork === false, 'EVENT')
  need(git('rev-parse', 'HEAD') === e.GITHUB_SHA && git('rev-parse', 'HEAD^') === base
    && git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort().join('\n') === ['.github/workflows/infisical-cloud-capabilities.yml', 'scripts/ops/self-hosted-github-revocation-closeout.mjs'].join('\n'), 'SOURCE')
  report.driver = { sha: e.GITHUB_SHA, parent: base, run: e.GITHUB_RUN_ID, attempt: 1 }
  if (e.MIKKA_GITHUB_PREFLIGHT === '1') { console.log(JSON.stringify({ preflight: 'passed', ...report.driver })); process.exit(0) }
  need(/^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(e.SMOKE_OWNER_EMAIL ?? '') && e.SMOKE_OWNER_PASSWORD, 'SMOKE_ACCOUNT')
  need((await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim() === revision, 'IMAGE_SOURCE')
  const { createSessionClient } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const { Pool } = createRequire(source + '/package.json')('pg')
  report.stage = 'account'
  report.privateBefore = await deployment()
  cloud = createSessionClient(publicOrigin, (url, init) => fetch(url, { ...init, redirect: 'manual' }))
  await cloud.json('/api/auth/sign-in/email', post({ email: e.SMOKE_OWNER_EMAIL, password: e.SMOKE_OWNER_PASSWORD }))
  const identity = await cloud.json('/api/auth/get-session?disableCookieCache=true')
  need(identity.user?.email?.toLowerCase() === e.SMOKE_OWNER_EMAIL.toLowerCase() && identity.user.emailVerified === true, 'IDENTITY')
  ownerId = identity.user.id; originalWorkspace = (await cloud.json('/api/workspace')).workspace.id
  report.publicBefore = (await cloud.json('/api/version')).build
  const choices = (await cloud.json('/api/workspace')).choices
  const billingChoices = choices.filter(w => w.kind === 'personal' && sha(w.id).slice(0,16) === '683a9e11b0c2d41f')
  need(billingChoices.length === 1, 'PAID_WORKSPACE_SCOPE')
  const billingWorkspace = billingChoices[0].id
  const eligibility = await cloud.rpc('billing.getHostedUsage', [billingWorkspace])
  need(eligibility.state === 'ready' && eligibility.balance?.verified === true
    && Number(eligibility.balance.free) + Number(eligibility.balance.purchased) > 0, 'PAID_WORKSPACE_ELIGIBILITY')
  report.billingWorkspaceHash = sha(billingWorkspace).slice(0,16)
  report.billingSelection = 'existing_paid_personal_normal_oauth'
  report.sharedTeamBillingChanged = false
  await cloud.rpc('workspace.switchWorkspace', [billingWorkspace])
  report.stage = 'self_hosted_bootstrap'
  const name = 'mikka-github-' + e.GITHUB_RUN_ID, password = randomBytes(24).toString('base64url'), key = randomBytes(32).toString('base64')
  await docker(['network', 'create', name]); resources.push(['network', name])
  await docker(['run', '-d', '--name', name + '-pg', '--network', name, '-p', '127.0.0.1:55439:5432', '-e', 'POSTGRES_USER=mikka', '-e', 'POSTGRES_DB=github1565_e2e', '-e', 'POSTGRES_PASSWORD=' + password, 'postgres:17-alpine']); resources.push(['container', name + '-pg'])
  await docker(['run', '-d', '--name', name + '-mail', '--network', name, '-p', '127.0.0.1:58025:8025', 'axllent/mailpit:v1.27.4']); resources.push(['container', name + '-mail'])
  ingress = observeIngress(receipts, deliveries)
  await new Promise(done => ingress.listen(3900, '127.0.0.1', done))
  tunnel = spawn(e.RUNNER_TEMP + '/mikka-cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3900', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const origin = await new Promise((done, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('SERVICES_TUNNEL')), 45000)
    const onData = b => { text = (text + b).slice(-64000); const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text); if (m && text.includes('Registered tunnel connection')) { clearTimeout(timer); done(m[0]) } }
    tunnel.stdout.on('data', onData); tunnel.stderr.on('data', onData); tunnel.once('error', () => { clearTimeout(timer); reject(Error('SERVICES_TUNNEL')) })
  })
  report.origin = origin
  const inspect = JSON.parse(await docker(['image', 'inspect', image]))[0]
  need(inspect.Id === 'sha256:1fb3725678739bf9d448be52ca5ba576ed3e7902b4c9e1240bd5c174f13754b4'
    && inspect.Config?.Labels?.['org.opencontainers.image.revision'] === revision && inspect.RepoDigests?.includes(image)
    && inspect.Config.Env.includes('MIKKA_CLOUD_WORKER_SOURCE_COMMIT=' + revision)
    && inspect.Config.Env.includes('MIKKA_CLOUD_WORKER_SHA=6ada1d4f809eace6ca84ad0329562f4aacb78452'), 'IMAGE_DIGEST')
  report.imageId = inspect.Id
  const appEnv = { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: key, WORKSPACE_SECRETS_KEY: key, CREDENTIAL_MASTER_KEY: key,
    DEVICE_GATEWAY_PUSH_SECRET: key, CRON_SECRET: key, MIKKA_EXTERNAL_CRON: '1', MIKKA_EDITION: 'community',
    DATABASE_URL: `postgres://mikka:${password}@${name}-pg:5432/github1565_e2e`, MIKKA_DATABASE_URL: `postgres://mikka:${password}@${name}-pg:5432/github1565_e2e`,
    SMTP_URL: `smtp://${name}-mail:1025`, MIKKA_EMAIL_FROM: 'Mikka acceptance <login@selfhost.example.test>' }
  const startApp = () => execute('docker', ['run', '-d', '--name', name + '-app', '--network', name, '-p', '127.0.0.1:3000:3000', '--mount', `type=volume,source=${name}-data,target=/data`,
    ...Object.keys(appEnv).flatMap(k => ['--env', k]), image], { env: { ...process.env, ...appEnv }, encoding: 'utf8', timeout: 150000 })
  await startApp()
  resources.push(['container', name + '-app'], ['volume', name + '-data'])
  // External container/tunnel readiness only; chat data below waits on live events.
  const waitForApp = async () => {
    let ready = false
    for (let n = 0; n < 60 && !ready; n++) { try { const r = await fetch(origin + '/mikka/api/version', { signal: AbortSignal.timeout(5000) }); ready = r.ok && (await r.json()).build === revision } catch {} if (!ready) await new Promise(r => setTimeout(r, 2000)) }
    need(ready, 'STARTUP')
  }
  await waitForApp()
  community = createSessionClient(origin, (url, init) => fetch(url, { ...init, redirect: 'manual' }))
  const mailbox = new WebSocket('ws://127.0.0.1:58025/api/events'); await once(mailbox, 'open', { signal: AbortSignal.timeout(15000) })
  let mailTimer
  const mail = new Promise((done, reject) => { mailTimer = setTimeout(() => reject(Error('SERVICES_MAIL')), 30000); mailbox.onmessage = event => {
    for (const m of mailpitNotifications(event.data)) if (m.Type === 'new' && typeof m.Data?.ID === 'string' && m.Data.To?.some(to => to.Address === e.SMOKE_OWNER_EMAIL)) { clearTimeout(mailTimer); done(m.Data.ID) }
  } })
  mail.catch(() => {})
  try {
    await community.json('/api/auth/sign-up/email', post({ name: 'Mikka self-hosted service acceptance', email: e.SMOKE_OWNER_EMAIL, password: e.SMOKE_OWNER_PASSWORD }))
    const message = await (await fetch('http://127.0.0.1:58025/api/v1/message/' + await mail)).json()
    const link = String(message.Text).match(/https:\/\/[^\s]+\/mikka\/api\/auth\/verify-email\?[^\s]+/)?.[0]
    need(link && new URL(link).origin === origin, 'VERIFY_LINK'); const u = new URL(link)
    const verified = await community.request(u.pathname.slice('/mikka'.length) + u.search); need(verified.status === 302, 'VERIFY'); await verified.body?.cancel()
  } finally { clearTimeout(mailTimer); mailbox.close() }
  await community.json('/api/auth/sign-in/email', post({ email: e.SMOKE_OWNER_EMAIL, password: e.SMOKE_OWNER_PASSWORD }))
  const localIdentity = await community.json('/api/auth/get-session?disableCookieCache=true')
  need(typeof localIdentity.user?.id === 'string' && localIdentity.user.email === e.SMOKE_OWNER_EMAIL, 'LOCAL_IDENTITY')
  appEnv.MIKKA_SERVER_ADMIN_USER_IDS = localIdentity.user.id
  await docker(['rm', '-f', name + '-app']); await startApp(); await waitForApp()
  report.stage = 'cloud_binding'
  await community.json('/api/cloud/connect', post({ action: 'register', name: 'Self-hosted services ' + e.GITHUB_RUN_ID })); serverRegistered = true
  const bind = async workspaceId => {
    const binding = await community.json('/api/cloud/connect', post({ action: 'bind', scopes: ['github'] }))
    const u = new URL(binding.url); need(u.origin === publicOrigin, 'CONSENT_ORIGIN')
    const consent = await cloud.request(u.pathname.slice('/mikka'.length) + u.search)
    const html = await consent.text(), raw = /id="cloud-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html)
    need(raw, 'CONSENT'); const m = JSON.parse(raw[1]).model
    need(m.workspaces?.some(w => w.id === workspaceId), 'CONSENT_WORKSPACE')
    const approved = await cloud.request('/cloud/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: m.requestId, csrf_token: m.csrfToken, workspace_id: workspaceId, approve: 'true' }) })
    need(approved.status === 302, 'APPROVAL'); const callback = new URL(approved.headers.get('location')); await approved.body?.cancel()
    need(callback.origin === origin && callback.pathname === '/mikka/api/cloud/callback', 'CALLBACK_ORIGIN')
    const bound = await community.request(callback.pathname.slice('/mikka'.length) + callback.search); need(bound.status === 303, 'CALLBACK'); await bound.body?.cancel()
    const serverId = u.searchParams.get('client_id'); need(/^[a-f0-9-]{36}$/.test(serverId ?? ''), 'SERVER_ID'); return serverId
  }
  const cloudServer = await bind(billingWorkspace); report.serverId = cloudServer
  localPool = new Pool({ connectionString: `postgres://mikka:${password}@127.0.0.1:55439/github1565_e2e`, max: 2, connectionTimeoutMillis: 15000 })
  report.stage = 'github_installation'
  const repositories = (await cloud.json('/api/integrations/github')).repositories
  const ids = [...new Set(repositories.filter(r => r.fullName === 'alexj11324/Mikka').map(r => String(r.installationId)))]
  need(ids.length === 1 && /^[1-9][0-9]+$/.test(ids[0]), 'INSTALLATION')
  const installing = await community.request('/api/integrations/github/install')
  need(installing.status === 302, 'INSTALL_INTENT'); const intent = new URL(installing.headers.get('location')); await installing.body?.cancel()
  need(intent.origin === 'https://github.com' && intent.pathname === '/apps/mikka-github/installations/new', 'INSTALL_URL')
  const setup = await cloud.request('/cloud/v1/github/setup?' + new URLSearchParams({ installation_id: ids[0], state: intent.searchParams.get('state'), setup_action: 'install' }))
  need(setup.status === 302 && new URL(setup.headers.get('location')).origin === origin, 'INSTALL_SETUP'); await setup.body?.cancel()
  const discovered = await community.json('/api/integrations/github')
  need(discovered.repositories.some(r => r.fullName === 'alexj11324/Mikka' && String(r.installationId) === ids[0]), 'LOCAL_DISCOVERY')
  const { CloudClientStore } = await import(pathToFileURL(source + '/lib/cloud-services/store.ts'))
  const client = new CloudClientStore(localPool, appEnv)
  const linked = await (await client.request(localIdentity.user.id, 'github', '/v1/github/installations')).json()
  need(linked.githubAccountId === '183887963', 'GITHUB_RECIPIENT')
  const minted = await (await client.request(localIdentity.user.id, 'github', '/v1/github/installation-token', post({ installationId: ids[0], repositories: ['Mikka'] }))).json()
  need(typeof minted.token === 'string' && Date.parse(minted.expiresAt) > Date.now(), 'INSTALLATION_TOKEN'); appToken = minted.token
  report.installation = { linked: true, localDiscovery: true, nativeToken: true, repositoryRestricted: 'alexj11324/Mikka', expiresAt: minted.expiresAt }
  report.stage = 'control_webhook'
  const existing = await githubApi('/pulls/1809', undefined, e.GITHUB_TOKEN)
  need(existing.number === 1809 && existing.merged === true && existing.base.ref === 'acceptance/1565-42579532129-base'
    && existing.head.sha === 'f0c74168e682bde3ec804b78d32274b445a0aeca' && existing.merge_commit_sha === '3521d3334b9353c35abbaf423c64e2e2ad580686', 'EXISTING_OWN_FIXTURE')
  await githubApi('/pulls/1809', { ...post({ title: '测试1565 revocation control ' + e.GITHUB_RUN_ID }), method: 'PATCH' }, e.GITHUB_TOKEN)
  const control = await delivery('pull_request', 'edited', 1809, 180000)
  need(control.status === 202, 'CONTROL_RECEIVER'); report.controlWebhook = control
  const before = await fetch('https://api.github.com/installation/repositories', { headers: { authorization: 'Bearer ' + appToken, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
  report.nativeTokenBefore = before.status; need(before.status === 200, 'TOKEN_ACTIVE'); await before.body?.cancel()
  report.stage = 'revocation'
  const revokeStarted = Date.now()
  await community.json('/api/cloud/disconnect', post({ action: 'server' })); serverRegistered = false; report.cleanup.serverRevoked = true
  const committed = Date.now(), statuses = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const revoked = await fetch('https://api.github.com/installation/repositories', { headers: { authorization: 'Bearer ' + appToken, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
    statuses.push({ status: revoked.status, afterCommitMs: Date.now() - committed }); await revoked.body?.cancel()
    if (revoked.status === 401) break
    need(revoked.status === 200, 'TOKEN_READBACK_STATUS')
    if (attempt < 11) await new Promise(done => setTimeout(done, 2000))
  }
  report.nativeRevocation = { statuses, disconnectMs: committed - revokeStarted, providerInvalidated: statuses.at(-1).status === 401,
    mechanism: 'durable_post_commit_github_disposal', periodicProductPolling: false }
  need(report.nativeRevocation.providerInvalidated, 'TOKEN_REVOKED')
  const boundary = receipts.length
  await githubApi('/pulls/1809', { ...post({ title: '测试1565 revocation complete ' + e.GITHUB_RUN_ID }), method: 'PATCH' }, e.GITHUB_TOKEN)
  let forwarded = null
  try { forwarded = await delivery('pull_request', 'edited', 1809, 12000, boundary) } catch (error) { if (error.message !== 'SERVICES_WEBHOOK_DEADLINE') throw error }
  need(forwarded === null, 'POST_REVOKE_NOT_FORWARDED')
  report.revocation = { realEventAfterDisconnect: true, ingressControlPassedBeforeDisconnect: true, forwardingObservationMs: 12000, forwarded: false }
  report.privateAfter = await deployment(); need(report.privateBefore.id === report.privateAfter.id, 'PRIVATE_CHANGED')
  report.publicAfter = (await cloud.json('/api/version')).build
  report.status = 'passed'; report.stage = 'completed'
} catch (error) { report.code = safe(error); report.errorClass = error?.name ?? 'unknown'; if (/^[A-Z0-9]{5}$/.test(error?.code ?? '')) report.databaseCode = error.code; process.exitCode = 1; if (process.env.MIKKA_GITHUB_PREFLIGHT === '1') console.log(JSON.stringify({ preflight: 'failed', code: report.code })) }
finally {
  if (serverRegistered) { try { await community.json('/api/cloud/disconnect', post({ action: 'server' })); report.cleanup.serverRevoked = true } catch { report.cleanup.serverRevoked = false } }
  if (cloud && originalWorkspace) { try { const { restoreAcceptanceWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs')); await restoreAcceptanceWorkspace(cloud, ownerId, originalWorkspace); report.cleanup.workspaceRestored = true } catch { report.cleanup.workspaceRestored = false } }
  for (const client of [community, cloud].filter(Boolean)) { try { await client.json('/api/auth/sign-out', post({})); } catch { report.cleanup.sessionsSignedOut = false } }
  if ((cloud || community) && report.cleanup.sessionsSignedOut !== false) report.cleanup.sessionsSignedOut = true
  try { await localPool?.end() } catch { report.cleanup.databaseClosed = false }
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) { const done = once(tunnel, 'exit'); tunnel.kill('SIGTERM'); await done.catch(() => {}) }
  if (ingress) { ingress.closeAllConnections(); await new Promise(done => ingress.close(done)) }
  for (const [, id] of resources.filter(([k]) => k === 'container').reverse()) { try { await docker(['rm', '-f', '-v', id]) } catch { report.cleanup.docker = false } }
  for (const [kind, id] of resources.filter(([k]) => k !== 'container').reverse()) { try { await docker([kind, 'rm', id]) } catch { report.cleanup.docker = false } }
  try { await rm(process.env.RUNNER_TEMP + '/mikka-github-fixture', { recursive: true, force: true }); await rm(process.env.RUNNER_TEMP + '/mikka-github-trace.jsonl', { force: true }); report.cleanup.privateFiles = true } catch { report.cleanup.privateFiles = false }
  if (Object.values(report.cleanup).some(v => v === false)) report.status = 'failed'
  report.finishedAt = new Date().toISOString()
  if (process.env.MIKKA_GITHUB_PREFLIGHT !== '1') { await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/self-hosted-github.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); if (report.status !== 'passed') process.exitCode = 1 }
}

async function githubApi(path, init = {}, token = appToken, raw = false) {
  const response = await fetch('https://api.github.com/repos/alexj11324/Mikka' + path, { ...init, headers: { ...init?.headers, authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (raw) return response
  need(response.ok, 'GITHUB_HTTP_' + response.status)
  return response.status === 204 ? null : response.json()
}
function observeIngress(records, events) {
  return createServer((request, response) => {
    const chunks = []; request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const upstream = httpRequest({ hostname: '127.0.0.1', port: 3000, method: request.method, path: request.url, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response)
        incoming.once('end', () => {
          if (request.url !== '/mikka/api/cloud/webhooks/github') return
          try {
            const payload = JSON.parse(body)
            if (payload.repository?.full_name !== 'alexj11324/Mikka' || !payload.pull_request?.number) return
            const record = { event: request.headers['x-github-event'], action: payload.action, pullRequest: payload.pull_request.number, deliveryId: request.headers['x-github-delivery'], bodySha256: sha(body), status: incoming.statusCode }
            records.push(record); events.emit('delivery', record)
          } catch { /* Record no bodies or raw transport errors. */ }
        })
      })
      upstream.once('error', () => { response.writeHead(502); response.end() }); upstream.end(body)
    })
  })
}
async function delivery(event, action, number, milliseconds, boundary = 0) {
  const matches = r => r.event === event && r.action === action && r.pullRequest === number
  const existing = receipts.slice(boundary).find(matches); if (existing) return existing
  return new Promise((done, reject) => {
    const listener = record => { if (matches(record)) { clearTimeout(timer); deliveries.off('delivery', listener); done(record) } }
    const timer = setTimeout(() => { deliveries.off('delivery', listener); reject(Error('SERVICES_WEBHOOK_DEADLINE')) }, milliseconds)
    deliveries.on('delivery', listener)
  })
}
