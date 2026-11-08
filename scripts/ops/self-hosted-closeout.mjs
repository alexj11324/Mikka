import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const plan = JSON.parse(await readFile(new URL('./self-hosted-closeout-plan.json', import.meta.url), 'utf8'))
export function workflowGuard(env) {
  assert.equal(env.GITHUB_REPOSITORY, plan.repository, 'repository')
  assert.equal(env.GITHUB_REF, `refs/heads/${plan.branch}`, 'branch')
  assert.equal(env.GITHUB_ACTOR, 'alexj11324', 'actor')
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/, 'workflow source')
  assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/, 'run')
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'event')
}
const check = (ok, code) => { if (!ok) throw new Error(code) }
const digest = value => createHash('sha256').update(value).digest('hex')
async function json(url, options = {}) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...options })
  check(r.ok, `HTTP_${r.status}`)
  return r.json()
}
export async function sourceGuard(env) {
  workflowGuard(env)
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  for (const id of [plan.ciRun, plan.imageRun]) {
    const r = await json(`https://api.github.com/repos/${plan.repository}/actions/runs/${id}`, { headers })
    check(r.repository?.full_name === plan.repository && r.head_sha === plan.source && r.event === 'push'
      && r.status === 'completed' && r.conclusion === 'success', 'SOURCE_CI')
  }
  const version = await json(`${plan.publicOrigin}/mikka/api/version`)
  check(version.build === plan.source, 'PUBLIC_SOURCE_DRIFT')
  return version.build
}
async function privateGuard(env) {
  const headers = { Authorization: `Bearer ${env.VERCEL_TEAM_TOKEN}` }
  const p = await json(`https://api.vercel.com/v9/projects/${plan.cloudProject}?teamId=${plan.vercelTeam}`, { headers })
  check(p.targets?.production?.id === plan.cloudDeployment, 'CLOUD_DEPLOYMENT_DRIFT')
  const d = await json(`https://api.vercel.com/v13/deployments/${plan.cloudDeployment}?teamId=${plan.vercelTeam}`, { headers })
  check(d.readyState === 'READY' && d.meta?.githubCommitSha === plan.cloudSource, 'CLOUD_SOURCE_DRIFT')
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })

async function run(env) {
  workflowGuard(env)
  const root = join(env.RUNNER_TEMP, `mikka-closeout-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`)
  const output = resolve('.artifacts/self-hosted-closeout')
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(output, { recursive: true })
  const report = { source: plan.source, cloudSource: plan.cloudSource, workflowSource: env.GITHUB_SHA,
    started: new Date().toISOString(), stage: 'guards', checks: {}, screenshots: [], cleanup: {} }
  const project = `closeout-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  let tunnel, browser, context, local, serverId, cloudUserId, cloudWorkspaceId, cloudCsrf, localOrigin
  let registered = false
  const composePath = join(root, 'compose.json')
  const compose = (...args) => docker('compose', '-f', composePath, '-p', project, ...args)
  const cloudApi = async (path, body) => {
    const r = await context.request.fetch(`${plan.publicOrigin}${path}`, { method: body ? 'POST' : 'GET',
      ...(body ? { data: body, headers: { Origin: plan.publicOrigin, 'X-CSRF-Token': cloudCsrf } } : {}) })
    check(r.ok(), `CLOUD_HTTP_${r.status()}`); return r.json()
  }
  const localApi = async (path, body, accepted = [200]) => {
    const r = await local.request.fetch(`${localOrigin}/mikka${path}`, { method: body ? 'POST' : 'GET',
      ...(body ? { data: body, headers: { Origin: localOrigin } } : {}) })
    check(accepted.includes(r.status()), `LOCAL_HTTP_${r.status()}`)
    return r.json()
  }
  try {
    await sourceGuard(env); await privateGuard(env)
    check(env.SMOKE_OWNER_EMAIL && env.SMOKE_OWNER_PASSWORD, 'SMOKE_CREDENTIALS')
    report.stage = 'fixture'
    const password = randomBytes(24).toString('hex')
    console.log(`::add-mask::${password}`)
    tunnel = spawn(join(env.RUNNER_TEMP, 'cloudflared'), ['tunnel', '--url', 'http://127.0.0.1:3000', '--no-autoupdate'], { env: { PATH: env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] })
    localOrigin = await new Promise((accept, reject) => {
      let buffer = ''; const timer = setTimeout(() => reject(new Error('TUNNEL_TIMEOUT')), 45_000)
      tunnel.stderr.on('data', data => { buffer = (buffer + data).slice(-20_000); const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (match) { clearTimeout(timer); accept(match[0]) } })
      tunnel.once('error', reject)
    })
    const db = `postgres://mikka:${password}@postgres:5432/mikka_e2e`
    const fixture = { services: {
      postgres: { image: 'postgres:17-alpine', environment: { POSTGRES_DB: 'mikka_e2e', POSTGRES_USER: 'mikka', POSTGRES_PASSWORD: password },
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U mikka -d mikka_e2e'], interval: '3s', timeout: '3s', retries: 30 } },
      mailpit: { image: 'axllent/mailpit:v1.27.4', ports: ['127.0.0.1:8025:8025'], environment: { MP_DISABLE_VERSION_CHECK: 'true', MP_QUIET: 'true' } },
      app: { image: `ghcr.io/alexj11324/mikka:${plan.source}`, init: true, ports: ['127.0.0.1:3000:3000'], volumes: ['data:/data'],
        environment: { DATABASE_URL: db, MIKKA_DATABASE_URL: db, BETTER_AUTH_URL: localOrigin, MIKKA_COMMUNITY_UI: '1',
          SMTP_URL: 'smtp://mailpit:1025', MIKKA_EMAIL_FROM: 'Closeout <login@selfhost.example.test>' },
        depends_on: { postgres: { condition: 'service_healthy' }, mailpit: { condition: 'service_started' } } }
    }, volumes: { data: {} } }
    await writeFile(composePath, JSON.stringify(fixture), { mode: 0o600 })
    compose('up', '--detach', '--wait', '--wait-timeout', '240')
    let ready = false
    for (let i = 0; i < 30 && !ready; i++) {
      try { ready = (await json(`${localOrigin}/mikka/api/version`)).build === plan.source } catch {}
      if (!ready) await delay(2000)
    }
    check(ready, 'IMAGE_SOURCE')
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    local = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    const page = await local.newPage(), cloud = await context.newPage()
    const screenshot = async (target, name) => {
      check(/^[a-z0-9-]+$/.test(name), 'ARTIFACT_NAME')
      const path = join(output, `${name}.png`)
      await target.screenshot({ path, fullPage: true, mask: [target.locator('input[type=password],input[type=email]'),
        ...(serverId ? [target.locator(`section[id^="server-"]:not([id="server-${serverId}"])`)] : []),
        target.getByText(env.SMOKE_OWNER_EMAIL, { exact: false })] })
      report.screenshots.push({ name, sha256: digest(await readFile(path)) })
    }
    const both = async (target, url, name, prepare) => {
      for (const colorScheme of ['light', 'dark']) {
        await target.emulateMedia({ colorScheme }); await target.goto(url, { waitUntil: 'networkidle' })
        if (prepare) await prepare(target)
        await screenshot(target, `${name}-${colorScheme}`)
      }
    }
    report.stage = 'local-auth'
    const email = `closeout-${randomUUID()}@selfhost.example.test`, secret = randomBytes(24).toString('base64url')
    console.log(`::add-mask::${secret}`)
    await localApi('/api/auth/sign-up/email', { name: 'Self-hosted closeout', email, password: secret }, [200, 201])
    let message
    for (let i = 0; i < 20 && !message; i++) {
      const list = await json('http://127.0.0.1:8025/api/v1/messages')
      const found = list.messages?.find(m => m.To?.some(to => to.Address === email))
      if (found) message = await json(`http://127.0.0.1:8025/api/v1/message/${found.ID}`)
      else await delay(500)
    }
    const link = String(message?.Text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mikka\/api\/auth\/verify-email\?[^\s]+/)?.[0]
    check(link && new URL(link).origin === localOrigin, 'VERIFICATION_LINK')
    const verified = await local.request.get(link, { maxRedirects: 0 }); check(verified.status() === 302, 'EMAIL_VERIFICATION')
    await localApi('/api/auth/sign-in/email', { email, password: secret })
    const localSession = await localApi('/api/auth/get-session')
    check(localSession.user?.emailVerified === true, 'LOCAL_SESSION')
    check(/^[0-9a-zA-Z_-]+$/.test(localSession.user.id), 'LOCAL_USER_ID')
    // The operator appoints only the generated fixture user, as documented.
    fixture.services.app.environment.MIKKA_SERVER_ADMIN_USER_IDS = localSession.user.id
    await writeFile(composePath, JSON.stringify(fixture), { mode: 0o600 })
    compose('up', '--detach', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'app')
    report.checks.localVerifiedEmail = true
    report.stage = 'shared-auth'
    const auth = await context.request.post(`${plan.publicOrigin}/mikka/api/auth/sign-in/email`, {
      data: { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD }, headers: { Origin: plan.publicOrigin } })
    check(auth.ok(), 'SHARED_SIGN_IN')
    const session = await cloudApi('/mikka/api/auth/get-session')
    check(session.user?.email === env.SMOKE_OWNER_EMAIL, 'SHARED_SESSION'); cloudUserId = session.user.id
    const { selectTeamWorkspace } = await import('../acceptance/team-workspace.mjs')
    report.checks.team = await selectTeamWorkspace({ ownerId: cloudUserId, json: cloudApi })
    report.stage = 'registration'
    await both(page, `${localOrigin}/mikka/en/settings?section=cloud`, 'server-unregistered')
    await localApi('/api/cloud/connect', { action: 'register', name: `Closeout ${env.GITHUB_RUN_ID}` })
    registered = true
    const status = await localApi('/api/cloud/status'); serverId = status.serverId
    check(status.registered && status.administrator && /^[0-9a-f-]{36}$/.test(serverId), 'REGISTRATION')
    report.checks.registered = true
    await both(page, `${localOrigin}/mikka/en/settings?section=cloud`, 'server-registered')
    report.stage = 'consent'
    const management = await cloudApi('/mikka/cloud/v1/management/context'); cloudCsrf = management.csrfToken
    const personal = management.workspaces?.filter(w => w.kind === 'personal')
    check(personal?.length === 1, 'PERSONAL_WORKSPACE'); cloudWorkspaceId = personal[0].id
    const scopes = ['models']
    for (const colorScheme of ['light', 'dark']) {
      const bind = await localApi('/api/cloud/connect', { action: 'bind', scopes })
      const authorize = bind.url ?? bind.authorizeUrl
      check(typeof authorize === 'string' && new URL(authorize).origin === plan.publicOrigin
        && new URL(authorize).pathname === '/mikka/cloud/oauth/authorize', 'AUTHORIZE_URL')
      await cloud.emulateMedia({ colorScheme }); await cloud.goto(authorize, { waitUntil: 'networkidle' })
      await cloud.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
      await screenshot(cloud, `consent-${colorScheme}`)
      if (colorScheme === 'dark') {
        // OAuth's callback belongs to the self-hosted user's genuine browser session.
        // Open the same authorize request in that context, then perform a normal
        // cloud email sign-in there instead of fabricating or copying cookies.
        const login = await local.request.post(`${plan.publicOrigin}/mikka/api/auth/sign-in/email`, {
          data: { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD }, headers: { Origin: plan.publicOrigin } })
        check(login.ok(), 'OAUTH_SHARED_SIGN_IN')
        await selectTeamWorkspace({ ownerId: cloudUserId, json: async (path, body) => {
          const r = await local.request.fetch(`${plan.publicOrigin}${path}`, { method: body ? 'POST' : 'GET',
            ...(body ? { data: body, headers: { Origin: plan.publicOrigin } } : {}) })
          check(r.ok(), 'OAUTH_TEAM'); return r.json()
        } })
        await page.goto(authorize, { waitUntil: 'networkidle' })
        await page.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
        await page.getByRole('button', { name: /^(Allow|允许)$/ }).click()
        await page.waitForURL(u => u.origin === localOrigin, { timeout: 30_000 })
      }
    }
    check((await localApi('/api/cloud/status')).personal.connected, 'PERSONAL_BOUND')
    report.checks.personalBound = true
    await both(page, `${localOrigin}/mikka/en/settings?section=account`, 'personal-connected')
    report.stage = 'management'
    const manage = `${plan.publicOrigin}/mikka/cloud/manage?serverId=${encodeURIComponent(serverId)}`
    await both(cloud, manage, 'connections', async p => {
      await p.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
      await p.locator(`#server-${serverId}`).waitFor()
    })
    const connections = await cloudApi(`/mikka/cloud/v1/management/connections?workspace_id=${encodeURIComponent(cloudWorkspaceId)}`)
    const own = connections.servers?.find(s => s.id === serverId || s.serverId === serverId)
    check(own, 'OWN_CONNECTION')
    report.stage = 'personal-revocation'
    // The exact server card and selected personal workspace constrain the action.
    await cloud.locator('select').first().selectOption(cloudWorkspaceId)
    const card = cloud.locator(`#server-${serverId}`)
    const revoke = card.getByRole('button', { name: /^(Revoke|撤销)$/ })
    check(await revoke.count() === 1, 'OWN_GRANT_UNAMBIGUOUS')
    await revoke.click()
    await cloud.getByRole('dialog').waitFor()
    await screenshot(cloud, 'personal-revoke-confirm-dark')
    await cloud.getByRole('dialog').getByRole('button', { name: /^(Revoke|撤销)$/ }).click()
    await cloud.getByRole('dialog').waitFor({ state: 'hidden' })
    const rejected = await local.request.get(`${localOrigin}/mikka/api/cloud/models/billing`)
    check(rejected.status() === 403 && (await rejected.json()).error === 'cloud_server_revoked', 'NEXT_REQUEST_REVOCATION')
    report.checks.nextRequestRevoked = true
    await both(page, `${localOrigin}/mikka/en/settings?section=account`, 'personal-revoked')
    await localApi('/api/cloud/disconnect', { action: 'personal' })
    report.checks.personalDisconnected = true
    report.checks.teamKey = { verified: false, reason: 'requires_administrator_of_target_billing_team',
      targetAdminAvailable: management.workspaces.some(w => w.kind === 'team' && w.name === 'Acme Inc.' && w.role === 'admin') }
    await sourceGuard(env); await privateGuard(env)
    report.stage = 'completed-personal-binding'
  } catch (error) {
    // No raw provider, browser, Docker or HTTP response can enter a public log.
    report.failure = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CLOSEOUT_FAILED'
    process.exitCode = 1
  } finally {
    if (registered && local) {
      try { await localApi('/api/cloud/disconnect', { action: 'server' }); registered = false; report.cleanup.serverDisconnected = true }
      catch { report.cleanup.serverDisconnected = false; process.exitCode = 1 }
    }
    for (const [name, ctx, origin] of [['selfHosted', local, localOrigin], ['cloud', context, plan.publicOrigin], ['oauthCloud', local, plan.publicOrigin]]) {
      if (!ctx || !origin) continue
      try {
        const r = await ctx.request.post(`${origin}/mikka/api/auth/sign-out`, { data: {}, headers: { Origin: origin } })
        const s = await ctx.request.get(`${origin}/mikka/api/auth/get-session`)
        report.cleanup[`${name}Session`] = r.ok() && s.ok() && !(await s.json())?.user
        if (!report.cleanup[`${name}Session`]) process.exitCode = 1
      } catch { report.cleanup[`${name}Session`] = false; process.exitCode = 1 }
    }
    if (browser) { await browser.close(); report.cleanup.browser = true }
    try { compose('down', '--volumes', '--remove-orphans'); report.cleanup.fixture = true } catch { report.cleanup.fixture = false; process.exitCode = 1 }
    if (tunnel) { tunnel.kill('SIGTERM'); report.cleanup.tunnel = true }
    await rm(root, { recursive: true, force: true })
    report.finished = new Date().toISOString()
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ stage: report.stage, failure: report.failure, checks: report.checks, cleanup: report.cleanup }))
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--check')) { await sourceGuard(process.env); console.log('Immutable public source and CI verified') }
  else if (process.argv.includes('--private-check')) { await sourceGuard(process.env); await privateGuard(process.env); console.log('Immutable private deployment verified') }
  else await run(process.env)
}
