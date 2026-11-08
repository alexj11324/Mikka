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
  const report = { source: plan.source, imageDigest: plan.imageDigest, cloudSource: plan.cloudSource, workflowSource: env.GITHUB_SHA,
    started: new Date().toISOString(), stage: 'guards', checks: {}, screenshots: [], cleanup: {} }
  const project = `closeout-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  let tunnel, browser, context, local, serverId, cloudUserId, cloudWorkspaceId, cloudCsrf, localOrigin, modelBotId, modelLive
  let registered = false
  let interrupted = false, cleaning = false
  const signal = () => {
    interrupted = true; process.exitCode = 1
    // Interrupt browser operations while retaining the real session's request
    // context for revoking this fixture and signing out in finally.
    for (const ctx of [local, context]) for (const page of ctx?.pages() ?? []) void page.close().catch(() => {})
  }
  process.once('SIGTERM', signal); process.once('SIGINT', signal)
  const privateValues = [env.SMOKE_OWNER_EMAIL, env.SMOKE_OWNER_PASSWORD]
  const composePath = join(root, 'compose.json')
  const compose = (...args) => docker('compose', '-f', composePath, '-p', project, ...args)
  const cloudApi = async (path, body) => {
    check(!interrupted || cleaning, 'INTERRUPTED')
    const r = await context.request.fetch(`${plan.publicOrigin}${path}`, { method: body ? 'POST' : 'GET',
      ...(body ? { data: body, headers: { Origin: plan.publicOrigin,
        ...(path === '/mikka/api/rpc' ? { 'x-mikka-rpc': '1' } : {}),
        ...(cloudCsrf ? { 'X-CSRF-Token': cloudCsrf } : {}) } } : {}) })
    check(r.ok(), `CLOUD_HTTP_${r.status()}`); return r.json()
  }
  const localApi = async (path, body, accepted = [200]) => {
    check(!interrupted || cleaning, 'INTERRUPTED')
    const r = await local.request.fetch(`${localOrigin}/mikka${path}`, { method: body ? 'POST' : 'GET',
      ...(body ? { data: body, headers: { Origin: localOrigin } } : {}) })
    check(accepted.includes(r.status()), `LOCAL_HTTP_${r.status()}`)
    return r.json()
  }
  const replyBot = async () => {
    const workspace = await localApi('/api/workspace')
    const bot = await localApi('/api/bots', { name: `Cloud reply ${env.GITHUB_RUN_ID}` }, [201])
    modelBotId = bot.id
    check(bot.workspaceId === workspace.workspace.id, 'MODEL_BOT_WORKSPACE')
    if (env.CLOSEOUT_TEXT_ONLY_PROFILE === '1') {
      const active = await localApi(`/api/bots/${bot.id}/definition`)
      check(Number.isSafeInteger(active.version) && active.version > 0 && Array.isArray(active.definition?.tools), 'FIXTURE_PROFILE_READ')
      const saved = await localApi(`/api/bots/${bot.id}/definition`, { action: 'save', expectedVersion: active.version,
        requestId: randomUUID(), definition: { ...active.definition, tools: [], skills: [], hooks: ['audit'] } })
      check(saved.source === 'user' && saved.definition?.tools?.length === 0 && saved.definition?.hooks?.includes('audit'), 'FIXTURE_PROFILE_SAVED')
      report.checks.modelFixture = { ownerConfigured: true, declaredTools: 0, auditRetained: true, general66ToolCasePassed: false }
    }
    const hostedId = '00000000-0000-0000-0000-000000000000'
    const menu = await localApi(`/api/mobile/model?bot=${bot.id}`)
    check(menu.groups.some(group => group.options?.some(option => option.id === hostedId && option.hostedSource === 'cloud')), 'CLOUD_DEFAULT_MODEL_MISSING')
    const pick = await local.request.put(`${localOrigin}/mikka/api/mobile/model`, {
      data: { bot: bot.id, id: hostedId }, headers: { Origin: localOrigin } })
    check(pick.ok() && (await pick.json()).current?.id === hostedId, 'CLOUD_DEFAULT_MODEL_PICK')
    return bot
  }
  try {
    await sourceGuard(env); await privateGuard(env)
    check(env.SMOKE_OWNER_EMAIL && env.SMOKE_OWNER_PASSWORD, 'SMOKE_CREDENTIALS')
    report.stage = 'fixture'
    const password = randomBytes(24).toString('hex')
    privateValues.push(password)
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
      app: { image: `ghcr.io/alexj11324/mikka@${plan.imageDigest}`, init: true, ports: ['127.0.0.1:3000:3000'],
        volumes: ['data:/data', `${resolve('scripts/ops/model-wire-diagnostics.mjs')}:/opt/closeout/model-wire-diagnostics.mjs:ro`],
        environment: { DATABASE_URL: db, MIKKA_DATABASE_URL: db, BETTER_AUTH_URL: localOrigin, MIKKA_COMMUNITY_UI: '1',
          MIKKA_EXTERNAL_CRON: '1',
          MIKKA_MODEL_WIRE_DIAGNOSTICS: '1', NODE_OPTIONS: '--import=/opt/closeout/model-wire-diagnostics.mjs',
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
    check(!interrupted, 'INTERRUPTED')
    report.stage = 'browser'
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    local = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    const page = await local.newPage(), cloud = await context.newPage()
    const observedPages = [page, cloud]
    for (const target of observedPages) {
      target.on('request', request => {
        const u = new URL(request.url())
        if (u.origin !== plan.publicOrigin || u.pathname !== '/mikka/cloud/oauth/authorize' || request.method() !== 'POST') return
        const form = new URLSearchParams(request.postData() ?? '')
        report.consentPosts ??= []
        report.consentPosts.push({ approve: ['true', 'false'].includes(form.get('approve')) ? form.get('approve') : form.has('approve') ? 'other' : 'missing',
          csrfPresent: Boolean(form.get('csrf_token')), requestIdPresent: Boolean(form.get('request_id')),
          workspaceMatches: form.get('workspace_id') === cloudWorkspaceId })
      })
      target.on('response', response => {
        const u = new URL(response.url())
        if (response.request().method() === 'POST' && u.origin === plan.publicOrigin && u.pathname === '/mikka/cloud/oauth/authorize') {
          report.consentStatuses ??= []; report.consentStatuses.push(response.status())
        }
      })
    }
    const screenshot = async (target, name) => {
      check(!interrupted, 'INTERRUPTED')
      check(/^[a-z0-9-]+$/.test(name), 'ARTIFACT_NAME')
      const path = join(output, `${name}.png`)
      await target.screenshot({ path, fullPage: true, animations: 'disabled', mask: [target.locator('input[type=password],input[type=email],input[readonly]'),
        ...(serverId ? [target.locator(`section[aria-labelledby^="server-"]:not([aria-labelledby="server-${serverId}"])`)] : []),
        target.getByText(env.SMOKE_OWNER_EMAIL, { exact: false })] })
      report.screenshots.push({ name, sha256: digest(await readFile(path)) })
    }
    const both = async (target, url, name, prepare) => {
      for (const colorScheme of ['light', 'dark']) {
        await target.emulateMedia({ colorScheme }); await target.goto(url, { waitUntil: 'networkidle' })
        if (new URL(url).origin === localOrigin) {
          const skip = target.getByRole('button', { name: /^(Skip setup|跳过设置)$/ })
          if (await skip.isVisible()) {
            await skip.click(); await skip.waitFor({ state: 'hidden' })
            await target.goto(url, { waitUntil: 'networkidle' })
          }
          if (url.includes('section=cloud')) await target.locator('#cloud-heading').waitFor()
          if (url.includes('section=account')) await target.locator('#personal-cloud-heading').waitFor()
        }
        if (prepare) await prepare(target)
        await screenshot(target, `${name}-${colorScheme}`)
      }
    }
    report.stage = 'local-auth'
    const email = `closeout-${randomUUID()}@selfhost.example.test`, secret = randomBytes(24).toString('base64url')
    privateValues.push(email, secret)
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
        report.stage = 'consent-oauth-signin'
        // OAuth's callback belongs to the self-hosted user's genuine browser session.
        // Open the same authorize request in that context, then perform a normal
        // cloud email sign-in there instead of fabricating or copying cookies.
        const login = await local.request.post(`${plan.publicOrigin}/mikka/api/auth/sign-in/email`, {
          data: { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD }, headers: { Origin: plan.publicOrigin } })
        check(login.ok(), 'OAUTH_SHARED_SIGN_IN')
        report.stage = 'consent-oauth-workspace'
        await selectTeamWorkspace({ ownerId: cloudUserId, json: async (path, body) => {
          const r = await local.request.fetch(`${plan.publicOrigin}${path}`, { method: body ? 'POST' : 'GET',
            ...(body ? { data: body, headers: { Origin: plan.publicOrigin,
              ...(path === '/mikka/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) } } : {}) })
          check(r.ok(), 'OAUTH_TEAM'); return r.json()
        } })
        report.stage = 'consent-oauth-render'
        await page.goto(authorize, { waitUntil: 'networkidle' })
        await page.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
        report.stage = 'consent-approve'
        const submission = page.waitForResponse(response => new URL(response.url()).origin === plan.publicOrigin
          && new URL(response.url()).pathname === '/mikka/cloud/oauth/authorize' && response.request().method() === 'POST')
        await page.getByRole('button', { name: /^(Allow|允许)$/ }).click()
        const submitted = await submission
        if (submitted.status() === 403 && report.consentPosts?.at(-1)?.approve === 'missing'
          && env.CLOSEOUT_PROTOCOL_PROBE === '1') {
          // This is a separately labelled authenticated protocol case. It
          // cannot turn the broken native consent UI into passing acceptance.
          report.checks.nativeConsentUI = { verified: false, httpStatus: 403, reason: 'submitter_value_missing' }
          process.exitCode = 1
          const next = await localApi('/api/cloud/connect', { action: 'bind', scopes })
          const nextURL = new URL(next.url)
          check(nextURL.origin === plan.publicOrigin && nextURL.pathname === '/mikka/cloud/oauth/authorize', 'PROTOCOL_AUTHORIZE_TARGET')
          await page.goto(nextURL.href, { waitUntil: 'networkidle' })
          await page.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
          const fields = await page.locator('form').evaluate(form => Object.fromEntries(new FormData(form)))
          check(Object.keys(fields).sort().join(',') === 'csrf_token,request_id,workspace_id'
            && fields.workspace_id === cloudWorkspaceId && fields.csrf_token && fields.request_id, 'PROTOCOL_CONSENT_FIELDS')
          const approved = await local.request.post(`${plan.publicOrigin}/mikka/cloud/oauth/authorize`, {
            form: { ...fields, approve: 'true' }, headers: { Origin: plan.publicOrigin }, maxRedirects: 0 })
          check(approved.status() === 303 || approved.status() === 302, 'PROTOCOL_CONSENT_RESPONSE')
          const callback = new URL(approved.headers().location)
          check(callback.origin === localOrigin && callback.pathname === '/mikka/api/cloud/callback'
            && !callback.username && !callback.password && !callback.hash && callback.searchParams.getAll('code').length === 1
            && callback.searchParams.getAll('state').length === 1, 'PROTOCOL_CALLBACK_TARGET')
          await page.goto(callback.href, { waitUntil: 'networkidle' })
          report.checks.protocolConsent = { approved: true, browserUIAcceptance: false }
        } else check(submitted.status() >= 300 && submitted.status() < 400, 'NATIVE_CONSENT_RESPONSE')
        report.stage = 'consent-callback'
        await page.waitForURL(u => u.origin === localOrigin, { timeout: 30_000 })
      }
    }
    check((await localApi('/api/cloud/status')).personal.connected, 'PERSONAL_BOUND')
    report.checks.personalBound = true
    report.fixtureServerId = serverId
    await both(page, `${localOrigin}/mikka/en/settings?section=account`, 'personal-connected')
    if (env.CLOSEOUT_MODELS === '1') {
      report.stage = 'hosted-coordinator'
      const { decode } = await import('../../lib/desktop-rpc/wire.ts')
      const usage = async () => {
        const response = await cloudApi('/mikka/api/rpc', { version: 1, action: 'billing.getHostedUsage', args: [cloudWorkspaceId] })
        check(response.version === 1 && response.ok === true, 'BILLING_RPC')
        const value = decode(response.result)
        check(!value.error && value.workspaceId === cloudWorkspaceId && Array.isArray(value.recent), 'BILLING_WORKSPACE')
        return value
      }
      const before = await usage()
      check(before.state === 'ready' && before.balance.verified === true && Number(before.balance.free) + Number(before.balance.purchased) > 0,
        'BOUND_PAYER_NOT_READY')
      const priorUsage = new Set(before.recent.map(r => r.id))
      const workspace = await localApi('/api/workspace')
      const { socketEvents, chatObservation } = await import('../acceptance/self-hosted-services.mjs')
      const ticket = await localApi(`/api/live/ticket?workspace=${workspace.workspace.id}`)
      const liveURL = new URL(ticket.url)
      check(liveURL.origin === localOrigin.replace('https:', 'wss:') && liveURL.pathname.startsWith('/mikka/v1/live/'), 'LOCAL_LIVE_TARGET')
      liveURL.searchParams.set('revisions', '1')
      modelLive = socketEvents(liveURL.href, ticket.protocol); await modelLive.ready
      await modelLive.next(event => event.type === 'live_ready' && event.version === 2)
      const bot = await replyBot()
      const observeChat = (chat, phase) => {
        const observation = { phase, ...chatObservation(chat, 'CLOUD_CLOSEOUT_OK') }
        const known = ['cloud_quota_exhausted', 'cloud_access_denied', 'cloud_server_revoked', 'cloud_unavailable',
          'cloud_invalid_request', 'cloud_not_connected', 'cloud_rate_limited']
        if (known.includes(chat.failure?.cloudCode)) observation.cloudCode = chat.failure.cloudCode
        for (const code of known) {
          const plain = chat.error === code || chat.error === `${code} (response)`
          const fatal = chat.error === `FatalError: ${code}` || chat.error === `FatalError: ${code} (response)`
          const error = chat.error === `Error: ${code}` || chat.error === `Error: ${code} (response)`
          const raw = chat.failure?.raw === code || chat.failure?.raw === `${code} (response)`
          if (plain || fatal || error || raw) {
            observation.storedCloudCode = code
            observation.storedCloudWrapper = fatal ? 'FatalError' : error ? 'Error' : plain ? 'none' : 'raw-only'
          }
        }
        report.coordinatorObservations ??= []
        if (report.coordinatorObservations.length < 8) report.coordinatorObservations.push(observation)
        else report.coordinatorObservations[7] = observation
      }
      observeChat(await localApi(`/api/mobile/chat?bot=${bot.id}`), 'before-message')
      await localApi('/api/mobile/chat', { botId: bot.id, text: 'Reply only CLOUD_CLOSEOUT_OK. Do not call any tools.', submissionId: randomUUID() }, [202])
      const deadline = Date.now() + 120_000
      for (;;) {
        const chat = await localApi(`/api/mobile/chat?bot=${bot.id}`)
        observeChat(chat, 'after-message')
        check(chat.enabled === true && !chat.error && !chat.failure, 'CLOUD_COORDINATOR_REFUSED')
        if (!chat.working && chat.items?.some(item => item.from === 'coordinator' && item.text?.trim() === 'CLOUD_CLOSEOUT_OK')) break
        check(Date.now() < deadline, 'CLOUD_COORDINATOR_TIMEOUT')
        await modelLive.next(event => event.kind === 'bot_chat' && event.id === bot.id, deadline - Date.now())
      }
      await modelLive.close(); modelLive = null
      let after, fresh
      for (let i = 0; i < 10; i++) {
        after = await usage(); fresh = after.recent.filter(row => !priorUsage.has(row.id))
        if (fresh.length && fresh.every(row => row.state === 'settled')) break
        await delay(1000)
      }
      check(fresh.some(row => row.model === 'deepseek/deepseek-v4.1-flash') && fresh.length <= 8
        && fresh.every(row => ['deepseek/deepseek-v4.1-flash', 'openai/gpt-6-luna-decisions'].includes(row.model)
        && row.state === 'settled' && Number.isSafeInteger(Number(row.costMicroUsd)) && Number(row.costMicroUsd) > 0), 'HOSTED_SETTLEMENT')
      report.checks.hostedCoordinator = { replied: true, model: 'deepseek/deepseek-v4.1-flash', billingWorkspaceMatchesBinding: true,
        controlWorkspace: 'shared-team', payerKind: 'existing-personal-binding', modelCalls: fresh.length,
        settledMicroUsd: fresh.reduce((sum, row) => sum + Number(row.costMicroUsd), 0),
        models: [...new Set(fresh.map(row => row.model))],
        inputTokens: fresh.reduce((sum, row) => sum + Number(row.inputTokens), 0),
        outputTokens: fresh.reduce((sum, row) => sum + Number(row.outputTokens), 0) }
      await both(page, `${localOrigin}/mikka/en/?bot=${bot.id}`, 'hosted-reply',
        p => p.getByRole('region', { name: bot.name, exact: true }).getByText('CLOUD_CLOSEOUT_OK', { exact: true }).waitFor())
      const billing = await localApi('/api/cloud/models/billing')
      const billingURL = new URL(billing.url)
      check(billingURL.origin === plan.publicOrigin && billingURL.searchParams.get('workspace') === cloudWorkspaceId
        && billingURL.searchParams.get('section') === 'billing', 'CLOUD_BILLING_LINK')
      await both(cloud, billingURL.href, 'hosted-billing')
      await selectTeamWorkspace({ ownerId: cloudUserId, json: cloudApi })
    }
    report.stage = 'management'
    const manage = `${plan.publicOrigin}/mikka/cloud/manage?serverId=${encodeURIComponent(serverId)}`
    await both(cloud, manage, 'connections', async p => {
      await p.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
      await p.locator(`section[aria-labelledby="server-${serverId}"]`).waitFor()
    })
    const connections = await cloudApi(`/mikka/cloud/v1/management/connections?workspace_id=${encodeURIComponent(cloudWorkspaceId)}`)
    const own = connections.servers?.find(s => s.id === serverId || s.serverId === serverId)
    check(own, 'OWN_CONNECTION')
    report.stage = 'personal-revocation'
    // The exact server card and selected personal workspace constrain the action.
    const prepareRevoke = workspaceId => async p => {
      await p.locator('select[name=workspace_id]').selectOption(workspaceId)
      const card = p.locator(`section[aria-labelledby="server-${serverId}"]`)
      await card.waitFor()
      const revoke = card.getByRole('button', { name: /^(Revoke|撤销)$/ })
      check(await revoke.count() === 1, 'OWN_REVOCATION_UNAMBIGUOUS')
      await revoke.click(); await p.getByRole('dialog').waitFor()
    }
    await both(cloud, manage, 'personal-revoke-confirm', prepareRevoke(cloudWorkspaceId))
    await cloud.getByRole('dialog').getByRole('button', { name: /^(Revoke|撤销)$/ }).click()
    await cloud.getByRole('dialog').waitFor({ state: 'hidden' })
    const rejected = await local.request.get(`${localOrigin}/mikka/api/cloud/models/billing`)
    check(rejected.status() === 403 && (await rejected.json()).error === 'cloud_server_revoked', 'NEXT_REQUEST_REVOCATION')
    report.checks.nextRequestRevoked = true
    await both(cloud, manage, 'personal-authorization-revoked', async p => {
      await p.locator('select[name=workspace_id]').selectOption(cloudWorkspaceId)
      await p.locator(`section[aria-labelledby="server-${serverId}"]`).waitFor({ state: 'hidden' })
    })
    await both(page, `${localOrigin}/mikka/en/settings?section=account`, 'personal-revoked')
    await localApi('/api/cloud/disconnect', { action: 'personal' })
    report.checks.personalDisconnected = true
    report.stage = 'team-server-key'
    // #1564 explicitly requires another billing team for the server-key case.
    // The main application session remains in the authorized Acme workspace.
    const teams = management.workspaces.filter(w => w.kind === 'team' && w.role === 'admin')
    check(teams.length === 1 && teams[0].id !== cloudWorkspaceId, 'ADMIN_BILLING_TEAM_UNAMBIGUOUS')
    const billingTeam = teams[0].id
    const keyName = `Closeout key ${env.GITHUB_RUN_ID}`
    // Own disposable limit only. A team's zero cash balance does not imply
    // exhausted credit: active members may already share funded balances.
    const quotaProbe = env.CLOSEOUT_MODELS === 'quota-only'
    const monthlyLimitMicroUsd = quotaProbe ? 10_000 : 1_000_000
    await both(cloud, manage, 'team-key-configuration', async p => {
      await p.locator('select[name=workspace_id]').selectOption(billingTeam)
      await p.getByRole('button', { name: /^(New server key|新建服务器密钥)$/ }).first().click()
      const dialog = p.getByRole('dialog')
      await dialog.locator('#cloud-server-id').fill(serverId)
      await dialog.locator('#cloud-server-key-name').fill(keyName)
      await dialog.locator('#cloud-server-key-limit').fill(quotaProbe ? '0.01' : '1')
      for (const name of [/^(Official GitHub App|官方 GitHub App)$/, /^(iOS notifications|iOS 推送)$/]) {
        const checkbox = dialog.getByRole('checkbox', { name })
        if (await checkbox.isChecked()) await checkbox.uncheck()
      }
      await dialog.getByRole('button', { name: /^(Create key|创建密钥)$/ }).waitFor()
      // Server lookup must really finish; disabled Create is never bypassed.
      await p.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')]
        .some(b => /^(Create key|创建密钥)$/.test(b.textContent?.trim() ?? '') && !b.disabled))
    })
    await cloud.getByRole('dialog').getByRole('button', { name: /^(Create key|创建密钥)$/ }).click()
    const once = cloud.getByRole('dialog').locator('input[readonly]')
    await once.waitFor()
    const serverKey = await once.inputValue()
    privateValues.push(serverKey)
    check(serverKey.length > 30 && !/\s/.test(serverKey), 'SERVER_KEY_RETURN')
    console.log(`::add-mask::${serverKey}`)
    // This once-only value cannot survive a reload. Match the private UI's
    // existing boot palette to each emulated OS theme without changing data.
    for (const colorScheme of ['light', 'dark']) {
      await cloud.emulateMedia({ colorScheme })
      await cloud.evaluate(() => document.documentElement.classList.toggle('dark',
        window.matchMedia('(prefers-color-scheme: dark)').matches))
      await screenshot(cloud, `team-key-once-masked-${colorScheme}`)
    }
    report.checks.onceKeyThemes = ['light', 'dark']
    await cloud.getByRole('dialog').getByRole('button', { name: /^(Done|完成)$/ }).click()
    await localApi('/api/cloud/connect', { action: 'key', key: serverKey })
    check((await localApi('/api/cloud/status')).team.connected, 'TEAM_KEY_BOUND')
    await both(page, `${localOrigin}/mikka/en/settings?section=cloud`, 'team-key-bound')
    if (['1', 'quota-only'].includes(env.CLOSEOUT_MODELS)) {
      report.stage = 'server-key-quota'
      const { decode } = await import('../../lib/desktop-rpc/wire.ts')
      const rpc = await cloudApi('/mikka/api/rpc', { version: 1, action: 'billing.getHostedUsage', args: [billingTeam] })
      check(rpc.version === 1 && rpc.ok === true, 'TEAM_BILLING_RPC')
      const teamUsage = decode(rpc.result)
      check(!teamUsage.error && teamUsage.workspaceId === billingTeam && teamUsage.personal === false, 'TEAM_BILLING_SCOPE')
      const balance = Number(teamUsage.balance?.free) + Number(teamUsage.balance?.purchased)
      if (quotaProbe || balance === 0) {
        if (!modelBotId) await replyBot()
        const workspace = await localApi('/api/workspace')
        const { socketEvents } = await import('../acceptance/self-hosted-services.mjs')
        const ticket = await localApi(`/api/live/ticket?workspace=${workspace.workspace.id}`)
        const url = new URL(ticket.url); url.searchParams.set('revisions', '1')
        check(url.origin === localOrigin.replace('https:', 'wss:') && url.pathname.startsWith('/mikka/v1/live/'), 'QUOTA_LIVE_TARGET')
        modelLive = socketEvents(url.href, ticket.protocol); await modelLive.ready
        await modelLive.next(event => event.type === 'live_ready' && event.version === 2)
        await localApi('/api/mobile/chat', { botId: modelBotId, text: 'Reply only QUOTA_PROBE_OK. Do not use tools.', submissionId: randomUUID() }, [202])
        let refused
        const deadline = Date.now() + 90_000
        for (;;) {
          const chat = await localApi(`/api/mobile/chat?bot=${modelBotId}`)
          if (!chat.working && (chat.failure || chat.items?.some(item => item.from === 'coordinator'))) { refused = chat; break }
          check(Date.now() < deadline, 'QUOTA_REFUSAL_TIMEOUT')
          await modelLive.next(event => event.kind === 'bot_chat' && event.id === modelBotId, deadline - Date.now())
        }
        await modelLive.close(); modelLive = null
        const raw = refused.failure?.raw
        report.quotaObservation = { working: refused.working, failureKind: refused.failure?.kind,
          cloudCodePresent: refused.failure?.cloudCode === 'cloud_quota_exhausted',
          safeRawQuotaCodePresent: raw === 'cloud_quota_exhausted' || raw === 'cloud_quota_exhausted (response)',
          exactStoredCode: refused.error === 'cloud_quota_exhausted' || refused.error === 'cloud_quota_exhausted (response)',
          fatalWrapper: refused.error === 'FatalError: cloud_quota_exhausted' || refused.error === 'FatalError: cloud_quota_exhausted (response)' }
        // Only the exact SDK/name/code grammar may leave this disposable DB.
        // No arbitrary error text or tool/provider body enters the artifact.
        const safeWrappedQuota = /^(?:Step "step\/\/@ai-sdk\/workflow@[a-zA-Z0-9.+-]+\/\/(?:doStreamStep|doGenerateStep)" failed after \d+ retries: )?(?:(?:FatalError|CloudServiceError|Error): )?cloud_quota_exhausted(?: \(response\))?$/
        if (typeof refused.error === 'string' && safeWrappedQuota.test(refused.error)) report.quotaObservation.safeStoredError = refused.error
        report.quotaObservation.workflowPrefix = typeof refused.error === 'string' && refused.error.startsWith('Step "step//@ai-sdk/workflow@')
        const visible = {}
        for (const [locale, route] of [['en', 'en/'], ['zh-CN', 'zh-CN/']]) {
          const messages = JSON.parse(await readFile(resolve('messages', `${locale}.json`), 'utf8'))
          const text = messages.RunErrors.cloud_quota_exhausted.default
          check(typeof text === 'string' && text.length > 0, 'QUOTA_COPY')
          visible[locale] = true
          await both(page, `${localOrigin}/mikka/${route}?bot=${modelBotId}`, `zero-balance-${locale.toLowerCase()}`, async p => {
            try { await p.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 }) }
            catch { visible[locale] = false; process.exitCode = 1 }
          })
        }
        const failed = await localApi(`/api/mobile/chat?bot=${modelBotId}`)
        const exposed = !failed.working && failed.failure?.cloudCode === 'cloud_quota_exhausted'
        if (!exposed) process.exitCode = 1
        report.checks.quotaRefusal = { boundary: quotaProbe ? 'owned_server_key_reservation_limit' : 'workspace_balance',
          monthlyLimitMicroUsd, balanceZeroBefore: balance === 0, verifiedBefore: teamUsage.balance.verified === true,
          storedQuotaCodePresent: report.quotaObservation.safeRawQuotaCodePresent || report.quotaObservation.exactStoredCode || report.quotaObservation.fatalWrapper,
          apiCodeExposed: exposed, englishVisible: visible.en, chineseVisible: visible['zh-CN'], balanceMutatedByTest: false,
          accountBalanceExhaustionVerified: false }
      } else {
        report.checks.zeroBalanceQuota = { verified: false, reason: 'existing_team_has_nonzero_balance', balanceMutatedByTest: false }
        process.exitCode = 1
      }
    }
    await both(cloud, manage, 'team-key-created', async p => {
      await p.locator('select[name=workspace_id]').selectOption(billingTeam)
      await p.locator(`section[aria-labelledby="server-${serverId}"]`).getByText(keyName, { exact: true }).waitFor()
    })
    const teamConnections = await cloudApi(`/mikka/cloud/v1/management/connections?workspace_id=${encodeURIComponent(billingTeam)}`)
    const ownTeam = teamConnections.servers?.find(s => s.serverId === serverId)
    check(ownTeam?.keys?.length === 1 && ownTeam.keys[0].name === keyName && Number(ownTeam.keys[0].monthlyLimitMicroUsd) === monthlyLimitMicroUsd,
      'OWN_TEAM_KEY_IDENTITY')
    await both(cloud, manage, 'team-key-revoke-confirm', prepareRevoke(billingTeam))
    await cloud.getByRole('dialog').getByRole('button', { name: /^(Revoke|撤销)$/ }).click()
    await cloud.getByRole('dialog').waitFor({ state: 'hidden' })
    const teamRejected = await local.request.get(`${localOrigin}/mikka/api/cloud/models/billing`)
    check(teamRejected.status() === 403 && (await teamRejected.json()).error === 'cloud_server_revoked', 'NEXT_TEAM_REQUEST_REVOCATION')
    report.checks.teamKey = { verified: true, separateTeam: true, nextRequestRevoked: true, monthlyLimitMicroUsd }
    await both(cloud, manage, 'team-key-authorization-revoked', async p => {
      await p.locator('select[name=workspace_id]').selectOption(billingTeam)
      await p.locator(`section[aria-labelledby="server-${serverId}"]`).waitFor({ state: 'hidden' })
    })
    await both(page, `${localOrigin}/mikka/en/settings?section=cloud`, 'team-key-revoked')
    await localApi('/api/cloud/disconnect', { action: 'key' })
    await localApi('/api/cloud/disconnect', { action: 'server' })
    registered = false; report.cleanup.serverDisconnected = true
    check(!(await localApi('/api/cloud/status')).registered, 'SERVER_DISCONNECTED')
    await both(page, `${localOrigin}/mikka/en/settings?section=cloud`, 'server-disconnected')
    const logs = compose('logs', '--no-color', 'app')
    for (const ctx of [local, context]) for (const cookie of await ctx.cookies()) privateValues.push(cookie.value)
    check(!privateValues.some(v => typeof v === 'string' && v.length >= 8 && logs.includes(v)), 'APPLICATION_LOG_SECRET_OR_PII')
    report.checks.applicationLogs = { noFixtureCredentialsOrEmails: true, rawLogsPublished: false }
    await sourceGuard(env); await privateGuard(env)
    report.stage = report.checks.nativeConsentUI?.verified === false ? 'backend-completed-native-consent-ui-failed' : 'completed'
  } catch (error) {
    // No raw provider, browser, Docker or HTTP response can enter a public log.
    report.failure = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CLOSEOUT_FAILED'
    if (error?.name === 'TeamWorkspaceError') {
      const { publicTeamWorkspaceFailure } = await import('../acceptance/team-workspace.mjs')
      report.failure = 'TEAM_WORKSPACE_FAILED'; report.failureDetail = publicTeamWorkspaceFailure(error).detail
    }
    if (['ERR_MODULE_NOT_FOUND', 'ENOENT', 'ECONNREFUSED', 'ENOTFOUND', 'TimeoutError'].includes(error?.code ?? error?.name)) {
      report.failureDetail = error.code ?? error.name
    }
    const frame = [...String(error?.stack ?? '').matchAll(/self-hosted-closeout\.mjs:(\d+):(\d+)/g)].find(match => Number(match[1]) > 20)
    if (frame) report.failureFrame = { line: Number(frame[1]), column: Number(frame[2]) }
    if (/strict mode violation/.test(error?.message ?? '')) report.failureDetail = 'locator_ambiguous'
    if (modelBotId) {
      try {
        const messages = JSON.parse(await readFile(resolve('messages/en.json'), 'utf8'))
        const logs = compose('logs', '--no-color', 'app')
        report.modelWireShapes = logs.split('\n').flatMap(line => {
          try { const value = JSON.parse(line.slice(line.indexOf('{'))); return value?.kind === 'closeout_model_wire_shape' && value.version === 1 ? [value] : [] }
          catch { return [] }
        }).slice(0, 8)
        report.fixtureFetchInstrumentation = true
        report.appLogCodes = Object.keys(messages.RunErrors).filter(code => code.length > 5 && logs.includes(code))
        const sdkErrors = Object.keys(await import('ai')).filter(name => name.endsWith('Error'))
        report.appLogErrorNames = ['ModelAdmissionError', 'CloudServiceError', 'CodedError', 'TypeError', 'ReferenceError',
          'SerializationError', 'WorkflowRuntimeError', 'WorkflowError', 'FatalError', 'RetryableError',
          ...sdkErrors, ...sdkErrors.map(name => `AI_${name}`)]
          .filter(name => logs.includes(name))
      } catch { report.appLogDiagnosticsUnavailable = true }
    }
    process.exitCode = 1
  } finally {
    cleaning = true
    if (modelBotId && local) {
      try { await localApi('/api/mobile/chat/stop', { botId: modelBotId }); report.cleanup.coordinatorStopped = true }
      catch { report.cleanup.coordinatorStopped = false; process.exitCode = 1 }
    }
    if (modelLive) { try { await modelLive.close() } catch {} }
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
    process.off('SIGTERM', signal); process.off('SIGINT', signal)
    await rm(root, { recursive: true, force: true })
    report.finished = new Date().toISOString()
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ stage: report.stage, failure: report.failure, failureDetail: report.failureDetail,
      failureFrame: report.failureFrame,
      coordinatorObservations: report.coordinatorObservations, appLogCodes: report.appLogCodes, appLogErrorNames: report.appLogErrorNames,
      modelWireShapes: report.modelWireShapes,
      quotaObservation: report.quotaObservation,
      consentPosts: report.consentPosts, consentStatuses: report.consentStatuses, checks: report.checks, cleanup: report.cleanup }))
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--check')) { await import('@playwright/test'); await sourceGuard(process.env); console.log('Browser dependency, immutable public source and CI verified') }
  else if (process.argv.includes('--private-check')) { await sourceGuard(process.env); await privateGuard(process.env); console.log('Immutable private deployment verified') }
  else await run(process.env)
}
