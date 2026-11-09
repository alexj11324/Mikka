// Separate service acceptance: existing published image, no E2B VM or coding
// subscription retry, no shared card/credit mutation and no compatibility UI.
import { execFile, spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { mailpitNotifications, cloudChatResult } from './self-hosting-subscription-acceptance.mjs'

const base = '7ff20714f272f02d2ff8d32c98a397d79b51625b'
const revision = '88b144d52d091d7ff566c63fce6e902e33edc59e'
const image = 'ghcr.io/alexj11324/mikka@sha256:96de4972ea7820dca9d7f03d116f8a4589c662ee6a6db9cb33cf8ad0f89ec98e'
const publicOrigin = 'https://app.aspectlylabs.com'
const privateProject = 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc', teamId = 'team_C7lwxVVvnUicFli6112mvxpv'
const model = 'deepseek/deepseek-v4.1-flash', prefix = 'ops: inspect private cloud production subscriptions final services paid personal'
const execute = promisify(execFile), sha = x => createHash('sha256').update(x).digest('hex')
const need = (ok, code) => { if (!ok) throw Error('SERVICES_' + code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const report = { schema: 1, kind: 'real-self-hosted-cloud-services', startedAt: new Date().toISOString(), imageSource: revision,
  image, model, codingThreadsRequested: 0, driverVirtualMachines: 0, billingConfigurationWrites: 0, uiOpened: false, cases: {}, cleanup: {}, stage: 'guard', status: 'failed' }
const source = resolve(process.env.RUNNER_TEMP ?? '.', 'mikka-services-source')
let cloud, community, pool, tunnel, serverRegistered = false, originalWorkspace, ownerId, quotaWorkspace, quotaName
const resources = [], ownedBots = []
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
    && git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort().join('\n') === ['.github/workflows/infisical-cloud-capabilities.yml', 'scripts/ops/self-hosted-cloud-services-closeout.mjs'].join('\n'), 'SOURCE')
  report.driver = { sha: e.GITHUB_SHA, parent: base, run: e.GITHUB_RUN_ID, attempt: 1 }
  if (e.MIKKA_SERVICES_PREFLIGHT === '1') { console.log(JSON.stringify({ preflight: 'passed', ...report.driver })); process.exit(0) }
  need(/^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(e.SMOKE_OWNER_EMAIL ?? '') && e.SMOKE_OWNER_PASSWORD, 'SMOKE_ACCOUNT')
  need((await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim() === revision, 'IMAGE_SOURCE')
  await execute(process.execPath, [source + '/scripts/assert-test-model.mjs', model])
  const { createSessionClient } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const { socketEvents } = await import(pathToFileURL(source + '/scripts/acceptance/self-hosted-services.mjs'))
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
  pool = new Pool({ connectionString: e.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: true } })
  const readOnly = async work => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN READ ONLY'); await tx.query("SET LOCAL statement_timeout = '5s'")
      need((await tx.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only === 'on', 'READ_ONLY')
      return await work(tx)
    } finally { try { await tx.query('ROLLBACK') } finally { tx.release() } }
  }
  report.stage = 'self_hosted_bootstrap'
  const name = 'mikka-services-' + e.GITHUB_RUN_ID, password = randomBytes(24).toString('base64url'), key = randomBytes(32).toString('base64')
  await docker(['network', 'create', name]); resources.push(['network', name])
  await docker(['run', '-d', '--name', name + '-pg', '--network', name, '-p', '127.0.0.1:55439:5432', '-e', 'POSTGRES_USER=mikka', '-e', 'POSTGRES_DB=community_services_e2e', '-e', 'POSTGRES_PASSWORD=' + password, 'postgres:17-alpine']); resources.push(['container', name + '-pg'])
  await docker(['run', '-d', '--name', name + '-mail', '--network', name, '-p', '127.0.0.1:58025:8025', 'axllent/mailpit:v1.27.4']); resources.push(['container', name + '-mail'])
  tunnel = spawn(e.RUNNER_TEMP + '/mikka-cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3000', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    DATABASE_URL: `postgres://mikka:${password}@${name}-pg:5432/community_services_e2e`, MIKKA_DATABASE_URL: `postgres://mikka:${password}@${name}-pg:5432/community_services_e2e`,
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
  const localWorkspace = (await community.json('/api/workspace')).workspace.id
  appEnv.MIKKA_SERVER_ADMIN_USER_IDS = localIdentity.user.id
  await docker(['rm', '-f', name + '-app']); await startApp(); await waitForApp()
  report.stage = 'cloud_binding'
  await community.json('/api/cloud/connect', post({ action: 'register', name: 'Self-hosted services ' + e.GITHUB_RUN_ID })); serverRegistered = true
  const bind = async workspaceId => {
    const binding = await community.json('/api/cloud/connect', post({ action: 'bind', scopes: ['models'] }))
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
  const chat = async (client, workspaceId, label, quota = false) => {
    const evidence = { phase: 'bot', submissionAttempted: false, status: 'failed' }
    let socket
    try {
      const bot = await client.json('/api/bots', post({ name: '测试1567 ' + label + ' ' + e.GITHUB_RUN_ID }))
      need(/^[a-f0-9-]{36}$/.test(bot.id) && bot.workspaceId === workspaceId, 'BOT')
      evidence.botId = bot.id; ownedBots.push({ client, id: bot.id, local: client === community })
      evidence.phase = 'model_selection'
      const menu = await client.json('/api/mobile/model', { ...post({ bot: bot.id, id: '00000000-0000-0000-0000-000000000000' }), method: 'PUT' })
      need(menu.current?.kind === 'hosted' && (client !== community || menu.current.hostedSource === 'cloud'), 'MODEL_SELECTION')
      need(quota || menu.current.available === true, 'POSITIVE_MODEL_AVAILABLE')
      evidence.phase = 'live_ready'
      const ticket = await client.json('/api/live/ticket?workspace=' + workspaceId)
      socket = socketEvents(ticket.url, ticket.protocol); await socket.ready; await socket.next(v => v.type === 'live_ready')
      const marker = 'SELFHOSTED_CLOUD_' + randomUUID(), started = Date.now(), deadline = started + 150000
      let firstContentMs = null
      await execute(process.execPath, [source + '/scripts/assert-test-model.mjs', model])
      evidence.phase = 'submit'; evidence.submissionAttempted = true
      const submitted = await client.request('/api/mobile/chat', post({ botId: bot.id, text: 'Reply exactly ' + marker + '. Do not use tools, create tasks, or contact anyone.', submissionId: randomUUID() }))
      evidence.submissionHttpStatus = submitted.status
      const accepted = await submitted.json(); need(submitted.ok && !accepted?.error, 'CHAT_SUBMISSION_HTTP')
      evidence.phase = 'reply'
      while (Date.now() < deadline) {
        const response = await client.request('/api/mobile/chat?bot=' + bot.id); need(response.ok, 'CHAT_READ_HTTP')
        // error/failure are normal failed-turn DATA, not an API transport error.
        const snapshot = await response.json()
        if (firstContentMs === null && snapshot.items?.some(i => i.from === 'coordinator' && typeof i.text === 'string' && i.text.length > 0)) firstContentMs = Date.now() - started
        const result = cloudChatResult(snapshot, marker, quota)
        if (result) return { ...evidence, ...result, canonicalCodes: ['cloud_quota_exhausted','cloud_unavailable','cloud_access_denied','verification_required','points_exhausted','free_allowance_used','platform_paused','usage_cost_unavailable','usage_concurrency_limit'].filter(code => JSON.stringify({ error: snapshot.error, failure: snapshot.failure, cause: snapshot.cause }).includes(code)), phase: 'complete', firstContentObservedMs: firstContentMs, completedMs: Date.now() - started, observation: 'request_to_first_content_upper_bound_via_live' }
        await socket.next(v => v.kind === 'bot_chat' && v.id === bot.id, deadline - Date.now())
      }
      throw Error('SERVICES_CHAT_DEADLINE')
    } catch (error) { return { ...evidence, code: safe(error) } }
    finally { if (socket) { socket.close(); await Promise.race([socket.closed, new Promise(r => setTimeout(r, 5000))]) } }
  }
  report.stage = 'positive_chats'
  report.cases.selfHostedReply = await chat(community, localWorkspace, 'self-hosted')
  report.cases.directReply = await chat(cloud, billingWorkspace, 'direct')
  // A genuine new empty wallet: no balance edits and no zero-monthly-limit key.
  // A pending invite to our own mailbox disables the normal sole-member credit
  // fallback. This API returns an invitation link and sends no email.
  report.stage = 'zero_wallet_setup'
  quotaName = '测试1567 empty wallet ' + e.GITHUB_RUN_ID
  const created = await cloud.rpc('workspace.createWorkspace', [{ name: quotaName, slug: 'selfhost-quota-' + e.GITHUB_RUN_ID }]); quotaWorkspace = created.workspaceId
  need(/^[a-f0-9-]{36}$/.test(quotaWorkspace ?? ''), 'QUOTA_WORKSPACE')
  const alias = e.SMOKE_OWNER_EMAIL.replace('@', '-quota-' + e.GITHUB_RUN_ID + '@')
  await cloud.rpc('workspace.createWorkspaceInvitation', [{ workspaceId: quotaWorkspace, emails: [alias], role: 'member' }])
  const details = await cloud.json('/api/workspace?workspace=' + quotaWorkspace)
  const credit = await cloud.json('/api/settings/credit-billing?workspace=' + quotaWorkspace)
  const card = await cloud.json('/api/settings/card-verification?workspace=' + quotaWorkspace)
  const noShares = await readOnly(async tx => (await tx.query('SELECT NOT EXISTS(SELECT 1 FROM workspace_credit_shares WHERE "workspaceId"=$1) AS clear', [quotaWorkspace])).rows[0]?.clear)
  need(details.workspace?.id === quotaWorkspace && details.workspace?.kind === 'team' && details.members?.filter(m => m.status === 'active').length === 1
    && details.invitations?.some(i => i.status === 'pending' && Date.parse(i.expiresAt) > Date.now()) && credit.balancePoints === 0 && noShares === true, 'EMPTY_EFFECTIVE_PAYER')
  report.zeroWallet = { workspaceHash: sha(quotaWorkspace).slice(0, 16), ownBalanceZero: true, sharedPayers: 0, soloFallbackDisabledByPendingOwnInvitation: true,
    personalCardVerified: card.status === 'verified', existingBalancesEditedByFixture: false, monthlyLimitKeyUsed: false }
  report.stage = 'zero_wallet_chat'
  await bind(quotaWorkspace)
  try { report.cases.zeroWallet = await chat(community, localWorkspace, 'empty-wallet', true) } catch (error) { report.cases.zeroWallet = { status: 'failed', code: safe(error) } }
  const billing = new URL((await community.json('/api/cloud/models/billing')).url)
  need(billing.origin === publicOrigin && billing.searchParams.get('workspace') === quotaWorkspace && billing.searchParams.get('section') === 'billing', 'TOP_UP_LINK')
  report.zeroWallet.topUpWorkspaceMatches = true
  report.zeroWallet.bilingualCopy = {}
  for (const locale of ['zh-CN', 'en']) { const messages = JSON.parse(await readFile(source + '/messages/' + locale + '.json', 'utf8')); const copy = messages.RunErrors?.cloud_quota_exhausted?.default; need(typeof copy === 'string' && copy.length > 0, 'BILINGUAL_COPY'); report.zeroWallet.bilingualCopy[locale] = copy }
  report.stage = 'ledger'
  const rows = await readOnly(async tx => (await tx.query(`SELECT u.id::text AS "usageId",c.workspace_id=$2 AS "selectedWorkspace",c.workspace_id=$3 AS "zeroWorkspace",c.model,c.credential_kind,
    c.payer_workspace_id::text AS "payer",u.state,u."inputTokens",u."outputTokens",u."costMicroUsd",c.completed_at IS NOT NULL AS completed
    FROM cloud.model_calls c LEFT JOIN public.hosted_usage u ON u.id=c.usage_id WHERE c.server_id=$1 ORDER BY c.created_at LIMIT 14`, [cloudServer, billingWorkspace, quotaWorkspace])).rows)
  need(rows.length <= 13, 'LEDGER_BOUND')
  report.cloudLedger = rows.map(r => ({ selectedWorkspace: r.selectedWorkspace, zeroWorkspace: r.zeroWorkspace, model: r.model, credentialKind: r.credential_kind,
    usageHash: r.usageId ? sha(r.usageId).slice(0,16) : null, payerHash: r.payer ? sha(r.payer).slice(0, 16) : null, state: r.state, inputTokens: r.inputTokens === null ? null : Number(r.inputTokens), outputTokens: r.outputTokens === null ? null : Number(r.outputTokens),
    costMicroUsd: r.costMicroUsd === null ? null : Number(r.costMicroUsd), completed: r.completed }))
  need(rows.some(r => r.selectedWorkspace && r.model === model && r.state === 'settled' && r.costMicroUsd !== null && Number.isSafeInteger(Number(r.costMicroUsd)) && Number(r.costMicroUsd) >= 0 && Number(r.inputTokens) + Number(r.outputTokens) > 0 && r.payer === billingWorkspace), 'POSITIVE_LEDGER')
  need(!rows.some(r => r.zeroWorkspace && r.payer), 'ZERO_WALLET_PROVIDER_WORK')
  report.decisionAccepted = rows.some(r => r.selectedWorkspace && r.model === 'openai/gpt-6-luna-decisions' && r.state === 'settled' && r.payer === billingWorkspace)
  const billingPage = await cloud.rpc('billing.getHostedUsage', [billingWorkspace])
  const settled = rows.filter(r => r.selectedWorkspace && r.state === 'settled')
  need(Array.isArray(billingPage.recent) && settled.every(r => billingPage.recent.some(v => v.id === r.usageId && v.model === r.model && v.state === 'settled' && Number(v.costMicroUsd) === Number(r.costMicroUsd))), 'BILLING_PAGE_LEDGER')
  report.billingPageReceipt = { workspaceHash: sha(billingWorkspace).slice(0,16), endpoint: 'billing.getHostedUsage', matchedSettledCloudRows: settled.length, visuallyInspected: false }
  report.stage = 'version'
  report.privateAfter = await deployment(); need(report.privateBefore.id === report.privateAfter.id, 'PRIVATE_CHANGED')
  report.publicAfter = (await cloud.json('/api/version')).build
  report.status = Object.values(report.cases).every(c => c.status === 'passed') ? 'passed' : 'partial'
  report.stage = 'completed'
  if (Number.isFinite(report.cases.selfHostedReply.firstContentObservedMs) && Number.isFinite(report.cases.directReply.firstContentObservedMs))
    report.firstContentDifferenceMs = report.cases.selfHostedReply.firstContentObservedMs - report.cases.directReply.firstContentObservedMs
} catch (error) { report.code = safe(error); process.exitCode = 1; if (process.env.MIKKA_SERVICES_PREFLIGHT === '1') console.log(JSON.stringify({ preflight: 'failed', code: report.code })) }
finally {
  for (const bot of ownedBots) { try { await bot.client.rpc('coordinator.stopCoordinatorTurn', [bot.id]); } catch { report.cleanup.turnsStopped = false } }
  if (ownedBots.length && report.cleanup.turnsStopped !== false) report.cleanup.turnsStopped = true
  report.cleanup.publicTestBotRetention = ownedBots.filter(b => !b.local).map(b => ({ id: b.id, reason: 'named_test_bot_no_delete_api' }))
  if (serverRegistered) { try { await community.json('/api/cloud/disconnect', post({ action: 'server' })); report.cleanup.serverRevoked = true } catch { report.cleanup.serverRevoked = false } }
  if (quotaWorkspace) { try {
    const now = await cloud.json('/api/workspace?workspace=' + quotaWorkspace)
    const general = await cloud.json('/api/settings/workspace-general?workspace=' + quotaWorkspace)
    need(now.currentUserId === ownerId && now.workspace?.id === quotaWorkspace && now.workspace.name === quotaName
      && now.role === 'admin' && general.id === quotaWorkspace && general.canTransfer === true && general.personal === false, 'CLEANUP_OWNER')
    await cloud.rpc('workspace.switchWorkspace', [quotaWorkspace])
    await cloud.rpc('workspace-settings.deleteWorkspace', [quotaWorkspace, quotaName])
    need(!(await cloud.json('/api/workspace')).choices.some(w => w.id === quotaWorkspace), 'CLEANUP_READBACK')
    report.cleanup.emptyWorkspaceDeleted = true
  } catch { report.cleanup.emptyWorkspaceDeleted = false } }
  if (cloud && originalWorkspace) { try { const { restoreAcceptanceWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs')); await restoreAcceptanceWorkspace(cloud, ownerId, originalWorkspace); report.cleanup.workspaceRestored = true } catch { report.cleanup.workspaceRestored = false } }
  for (const client of [community, cloud].filter(Boolean)) { try { await client.json('/api/auth/sign-out', post({})); } catch { report.cleanup.sessionsSignedOut = false } }
  if ((cloud || community) && report.cleanup.sessionsSignedOut !== false) report.cleanup.sessionsSignedOut = true
  try { await pool?.end() } catch { report.cleanup.databaseClosed = false }
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) { const done = once(tunnel, 'exit'); tunnel.kill('SIGTERM'); await done.catch(() => {}) }
  for (const [kind, id] of resources.filter(([k]) => k === 'container').reverse()) { try { await docker(['rm', '-f', '-v', id]) } catch { report.cleanup.docker = false } }
  for (const [kind, id] of resources.filter(([k]) => k !== 'container').reverse()) { try { await docker([kind, 'rm', id]) } catch { report.cleanup.docker = false } }
  if (Object.values(report.cleanup).some(v => v === false)) report.status = 'failed'
  report.finishedAt = new Date().toISOString()
  if (process.env.MIKKA_SERVICES_PREFLIGHT !== '1') { await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/self-hosted-cloud-services.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); if (report.status !== 'passed') process.exitCode = 1 }
}
