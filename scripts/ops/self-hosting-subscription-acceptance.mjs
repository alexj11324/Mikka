// Run only in the existing OIDC Actions job. Real community image, isolated
// PostgreSQL, normal HTTP enrollment/dispatch and unchanged official CLIs.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { login, TARGET as INFI } from './infisical-cloud-capabilities.mjs'
import { smokeAccount } from './self-hosting-cloud-acceptance.mjs'

const execute = promisify(execFile)
const PUBLIC = 'https://app.aspectlylabs.com'
const PROJECT = INFI.project
const check = (v, code) => { if (!v) throw Error('COMMUNITY_' + code) }
const sha = v => createHash('sha256').update(v).digest('hex')
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
// Protocol redirects are inspected and origin/state checked by this driver.
// Never follow one automatically or turn an expected 302/303 into fetch error.
const manualRedirect = (url, init) => fetch(url, { ...init, redirect: 'manual' })

export function mailpitNotifications(data) {
  const messages = []
  for (const line of String(data).split('\n')) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) messages.push(value)
    } catch { /* Mailpit batches independent JSON records; preserve later valid notifications. */ }
  }
  return messages
}

// Exercise the normal authenticated collector twice on this run's disposable
// community server; the second call must not request Mikka cloud providers.
export async function inspectCommunityMonitoring(origin, cronSecret, request = fetch) {
  const url = new URL(origin)
  check(url.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)
    && url.href === url.origin + '/' && typeof cronSecret === 'string' && cronSecret.length >= 32, 'MONITOR_SCOPE')
  const ticks = []
  for (let tick = 0; tick < 2; tick++) {
    const response = await request(url.origin + '/mikka/api/cron/ops-monitor', { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(60000), headers: { authorization: 'Bearer ' + cronSecret } })
    let result
    try { result = await response.json() } catch (cause) { throw new Error('COMMUNITY_MONITOR_RESPONSE', { cause }) }
    const receipt = { tick: tick + 1, httpStatus: response.status, databaseAvailable: result?.databaseAvailable === true,
      persisted: result?.persisted === true, noStore: response.headers.get('cache-control') === 'no-store',
      cloudProviderNotApplicable: result?.egress?.status === 'not_applicable',
      notificationFailed: result?.notificationStatus === 'failed' }
    ticks.push(receipt)
  }
  return { status: ticks.every(row => row.httpStatus === 200 && row.databaseAvailable && row.persisted && row.noStore
      && row.cloudProviderNotApplicable && !row.notificationFailed) ? 'passed' : 'failed',
    scope: 'two_normal_authenticated_ticks_on_owned_community_instance', ticks }
}

export function communityReleaseCompatibility(imageRevision, publicRevision, comparison, mode) {
  check(mode === undefined || mode === 'native-delivery', 'ACCEPTANCE_MODE')
  const revision = /^[a-f0-9]{40}$/
  check(revision.test(imageRevision) && revision.test(publicRevision), 'RELEASE_BINDING')
  if (imageRevision === publicRevision) return { imageRevision, publicRevision, kind: 'same_revision', changedPaths: [] }
  check(comparison?.status === 'ahead' && comparison.behind_by === 0
    && comparison.merge_base_commit?.sha === imageRevision, 'RELEASE_ANCESTRY')
  if (mode === 'native-delivery') return { imageRevision, publicRevision,
    kind: 'independent_published_application_and_image', sourceEquivalenceClaimed: false,
    scope: 'real_api_cli_delivery_with_independently_verified_releases' }
  const files = comparison.files
  check(Array.isArray(files) && files.length > 0 && files.length < 300
    && new Set(files.map(row => row.filename)).size === files.length && files.every(row => {
      if (row.previous_filename || !['added', 'modified', 'removed'].includes(row.status)) return false
      if (row.filename?.startsWith('apps/mobile/') || row.filename?.startsWith('docs/')) return true
      return ['messages/en.json', 'messages/zh-CN.json'].includes(row.filename) && row.status === 'modified'
    }), 'RELEASE_DIFF')
  return { imageRevision, publicRevision, kind: 'mobile_documentation_or_locale', changedPaths: files.map(row => row.filename).sort() }
}

// Git main may advance while the pinned, fully released application remains
// deployed. Its immutable release and before/after public pins still govern
// this isolated self-hosted acceptance; no main freeze is acquired.
export function communityPublishedAncestry(publicRevision, mainRevision, comparison) {
  const revision = /^[a-f0-9]{40}$/
  check(revision.test(publicRevision) && revision.test(mainRevision), 'RELEASE_BINDING')
  if (publicRevision === mainRevision) return { publicRevision, mainRevision, kind: 'same_revision' }
  check(comparison?.status === 'ahead' && comparison.behind_by === 0
    && comparison.merge_base_commit?.sha === publicRevision, 'RELEASE_MAIN_ANCESTRY')
  return { publicRevision, mainRevision, kind: 'main_ahead_of_deployed_source' }
}

// Discovery is not authority: the normal Cloud setup still verifies the real
// GitHub manager, then the self-hosted installation must expose the target.
// The formal candidate publisher now has a specialized bootstrap protocol.
// This self-hosted personal device uses the already released normal daemon
// enrollment/start path instead; it is not a candidate publication gate.
export function communityDaemonHelper(raw, origin) {
  const bytes = Buffer.from(raw)
  check(createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'),bytes])).digest('hex')
    === 'bf546a0ef670b41f273d9f4c2e391220cfb6837c', 'HELPER_SOURCE')
  const url = new URL(origin)
  check(url.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)
    && url.origin === origin && !url.port && !url.username && !url.password, 'HELPER_ORIGIN')
  let prefix = raw.slice(0,raw.indexOf('  const link = new HttpServerLink'))
  prefix = prefix.replace("import { hostname, platform, arch } from 'node:os'\n", '')
  prefix = prefix.replace("import { DAEMON_PROTOCOL_VERSION } from '../../packages/protocol/src/index.ts'\n", '')
  prefix = prefix.replace("import { holdCandidateRegistration, publishCandidateBootstrap, waitForCandidateStart } from './acceptance-bootstrap.mts'\n", '')
  prefix = prefix.replace("  const workspaceId = process.env.MIKKA_ACCEPTANCE_WORKSPACE_ID\n", '')
  prefix = prefix.replace("  if (origin !== 'https://app.aspectlylabs.com' || (harness !== 'claude_code' && harness !== 'codex') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspaceId ?? '')) throw Error('candidate_configuration_invalid')","  if (origin !== 'https://app.aspectlylabs.com' || (harness !== 'claude_code' && harness !== 'codex')) throw Error('candidate_configuration_invalid')")
  prefix = prefix.replace("import { registrationLogin }","import { startDaemon } from '../../packages/daemon/src/main.ts'\nimport { registrationLogin }")
  prefix = prefix.replace("origin !== 'https://app.aspectlylabs.com'", 'origin !== ' + JSON.stringify(origin))
  return prefix + "  const link = new HttpServerLink(`${origin}/mikka`, fetch, DAEMON_VERSION)\n  const heartbeatProof: unknown[] = []\n  const originalHeartbeat = link.heartbeat.bind(link)\n  link.heartbeat = async (...args) => {\n    const result = await originalHeartbeat(...args)\n    heartbeatProof.push({ reported: args[1].runs.length, renewed: Object.keys(result.leases).length,\n      revoked: result.revoked?.length ?? 0, reportedRevoked: args[1].runs.filter(run => result.revoked?.includes(run.runId)).length })\n    await writeFile(dataDir + '/heartbeat-proof.json', JSON.stringify(heartbeatProof.slice(-12)), { mode: 0o600 })\n    return result\n  }\n  const register = link.registerDevice.bind(link)\n  let announced = false\n  link.registerDevice = async (...args) => {\n    const registered = await register(...args)\n    if (!announced) {\n      announced = true\n      const proof = { deviceId: registered.deviceId, harness, binary, binarySha256, version }\n      await writeFile(`${dataDir}/device-proof.json`, `${JSON.stringify(proof)}\\n`, { mode: 0o600, flag: 'wx' })\n      process.stdout.write(`mikka-template-device ${JSON.stringify(proof)}\\n`)\n    }\n    return registered\n  }\n  const daemon = await startDaemon({ dataDir, flavor: 'prod', link, credential, hostedSubscriptions: true,\n    // A personal candidate does not receive cloud-only repository task secrets.\n    // Opt in locally; enrollment, claim authority and the assignment stay normal.\n    collectCliTiming: true, harnesses: probe.reports, preloadedModels: probe, modelProbe: true })\n  const stop = () => { void daemon.stop().then(() => process.exit(0)) }\n  process.once('SIGTERM', stop)\n  process.once('SIGINT', stop)\n}\n\nvoid main().catch(error => {\n  const code = /^candidate_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'candidate_daemon_failed'\n  process.stderr.write(`${code}\\n`)\n  process.exitCode = 1\n})\n"
}

// MCP arguments follow the actual server catalogue. Legacy strict schemas
// reject workspaceId; their normal OAuth principal supplies the workspace.
export function nativeMcpParameters(params, workspaceId, tools) {
  check(UUID.test(workspaceId) && Array.isArray(tools) && tools.length <= 200
    && ['create_issue','dispatch_run'].includes(params?.name), 'MCP_CATALOGUE')
  const tool = tools.filter(row => row?.name === params.name)
  check(tool.length === 1 && tool[0].inputSchema?.properties && params.arguments
    && !Object.hasOwn(params.arguments,'workspaceId'), 'MCP_TOOL_SCHEMA')
  const scoped = Object.hasOwn(tool[0].inputSchema.properties,'workspaceId')
  return { ...params, arguments: { ...params.arguments, ...(scoped ? { workspaceId } : {}) } }
}

export function assertCommunityAdmission(env, now = Date.now()) {
  if (env.MIKKA_COMMUNITY_MODE !== 'native-delivery') return
  const value = env.MIKKA_COMMUNITY_ADMISSION_DEADLINE
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(now) && Number.isFinite(Date.parse(value)) && now <= Date.parse(value), 'ADMISSION_EXPIRED')
}

export function selectOfficialInstallation(repositories) {
  check(Array.isArray(repositories) && repositories.length <= 10000, 'GITHUB_INSTALLATION')
  const target = repositories.filter(r => r?.fullName === 'alexj11324/Mikka')
  const rows = target.length ? target : repositories.filter(r => r?.fullName === 'alexj11324/Mikka-handoff')
  const ids = [...new Set(rows.map(r => r.installationId))]
  check(ids.length === 1 && typeof ids[0] === 'string' && /^[1-9][0-9]{0,15}$/.test(ids[0])
    && Number.isSafeInteger(Number(ids[0])), 'GITHUB_INSTALLATION')
  return ids[0]
}

export function deliveryTask(run, harness, revision) {
  check(/^\d{8,20}$/.test(run) && ['claude','codex'].includes(harness) && /^[a-f0-9]{40}$/.test(revision), 'DELIVERY_SCOPE')
  const branch = `acceptance/selfhost-${run}-${harness}`
  const path = `docs/acceptance/self-hosted-batch/${run}-${harness}.md`
  const model = harness === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-luna'
  return { branch, path, model, revision,
    request: `Verify the self-hosted GitHub delivery path for #1560 and #1565. Work only in alexj11324/Mikka on the new branch ${branch}. Read README.md and docs/self-hosting.md. Add only ${path}, a short factual acceptance note naming source ${revision}, model ${model}, and the documented self-hosted Docker/email/live setup. Do not claim other acceptance passed. Commit this file with message "[skip ci] Record self-hosted delivery receipt", push this branch, and open one draft PR against main with title "Self-hosted ${harness} delivery receipt ${run}". This disposable documentation PR is delivery evidence and will be closed after verification. Do not merge, modify any other file, touch credentials, or dispatch other agents. Use the ordinary prepared GitHub credential and official CLI.` }
}

export function deliveryReceipt(task, pulls, files) {
  check(Array.isArray(pulls) && pulls.length === 1, 'DELIVERY_PR_COUNT')
  const pr = pulls[0]
  check(pr.state === 'open' && pr.draft === true && pr.head?.ref === task.branch
    && pr.head?.repo?.full_name === 'alexj11324/Mikka' && pr.base?.ref === 'main'
    && pr.base?.repo?.full_name === 'alexj11324/Mikka' && Number.isSafeInteger(pr.number)
    && pr.number > 0 && /^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')
    && pr.html_url === `https://github.com/alexj11324/Mikka/pull/${pr.number}`, 'DELIVERY_PR_SCOPE')
  check(Array.isArray(files) && files.length === 1 && files[0].filename === task.path
    && files[0].status === 'added' && files[0].additions > 0, 'DELIVERY_FILE_SCOPE')
  return { pullRequest: pr.number, url: pr.html_url, head: pr.head.sha, branch: task.branch,
    file: task.path, draft: true, clonePushAndPullRequest: true }
}

export async function cleanupDelivery(task, pulls, files, github) {
  const receipt = deliveryReceipt(task, pulls, files)
  const ref = await github('/git/ref/heads/' + task.branch)
  check(ref.ref === 'refs/heads/' + task.branch && ref.object?.sha === receipt.head, 'DELIVERY_CLEANUP_HEAD')
  const closed = await github('/pulls/' + receipt.pullRequest, 'PATCH', { state: 'closed' })
  check(closed.number === receipt.pullRequest && closed.state === 'closed' && !closed.merged
    && closed.head?.sha === receipt.head, 'DELIVERY_CLEANUP_CLOSE')
  await github('/git/refs/heads/' + task.branch, 'DELETE')
  return { pullRequestClosed: true, branchDeleted: true }
}

export function cloudChatResult(chat, marker, quota = false) {
  if (chat?.working || !chat?.items?.some(item => item.from === 'person' && item.text?.includes(marker))) return null
  if (chat.enabled === false) return { status: 'failed', code: 'COMMUNITY_CLOUD_CHAT_DISABLED' }
  const cloudCode = chat.failure?.cloudCode
  const allowed = ['cloud_not_connected','cloud_scope_missing','cloud_server_revoked','cloud_invalid_request','cloud_rate_limited','cloud_access_denied','cloud_unavailable','cloud_quota_exhausted']
  if (cloudCode && allowed.includes(cloudCode)) return { status: quota && cloudCode === 'cloud_quota_exhausted' ? 'passed' : 'refused',
    code: cloudCode, messageKey: 'RunErrors.' + cloudCode + '.default' }
  if (chat.error || chat.failure) return { status: 'failed', code: 'COMMUNITY_CLOUD_CHAT_FAILED' }
  const reply = chat.items.findLast(item => item.from === 'coordinator' && typeof item.text === 'string' && item.text.includes(marker))
  if (!reply) return null
  return quota ? { status: 'failed', code: 'COMMUNITY_CLOUD_QUOTA_NOT_ENFORCED' }
    : { status: 'passed', replyBytes: Buffer.byteLength(reply.text), replySha256: sha(reply.text) }
}

export function cloudModelBillingReceipt(rows, model, workspaceId, sharedPayers = new Map()) {
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 12, 'CLOUD_MODEL_LEDGER_COUNT')
  const recordedInteger = value => value !== null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const receipt = rows.map(row => {
    const payerKind = row.payerWorkspace === workspaceId ? 'workspace' : sharedPayers.get(row.payerWorkspace)
    check(row.workspaceMatches === true && row.ledgerPayerMatches === true && row.usageModelMatches === true
      && row.credentialKind === 'user' && ['workspace','shared_credit','solo_credit'].includes(payerKind)
      && [model,'openai/gpt-6-luna-decisions'].includes(row.model), 'CLOUD_MODEL_LEDGER_SCOPE')
    return { model: row.model, workspaceMatches: true, payerAuthorized: true, ledgerPayerMatches: true, payerKind,
      credentialKind: 'user', state: ['settled','pending','unknown','failed'].includes(row.state) ? row.state : 'OTHER',
      inputTokens: recordedInteger(row.inputTokens), outputTokens: recordedInteger(row.outputTokens),
      costMicroUsd: recordedInteger(row.costMicroUsd), completed: row.completed === true }
  })
  check(receipt.some(row => row.model === model && row.state === 'settled' && row.outputTokens > 0 && row.completed), 'CLOUD_MODEL_LEDGER')
  return receipt
}

// Observe the already-refused message through the actual released UI. The
// probe sends no new prompt and never clicks Retry or changes a model.
export function idleRequestKind(value, origin) {
  let url
  try { url = new URL(value) } catch { return 'invalid' }
  if (url.origin !== origin) return 'external'
  const path = url.pathname.startsWith('/mikka/') ? url.pathname.slice('/mikka'.length) : url.pathname
  if (path === '/api/version') return 'version'
  if (path.startsWith('/api/auth/')) return 'auth'
  if (path === '/api/live/ticket') return 'live_ticket'
  return path.startsWith('/api/') ? 'data_api' : 'asset'
}

export function idleRuntimeReceipt({ elapsedMs, counts, visibleStart, visibleEnd, liveStart, liveEnd, disconnections, pageErrors }) {
  check(Number.isSafeInteger(elapsedMs) && elapsedMs >= 60000 && elapsedMs <= 90000
    && ['data_api','version','auth','live_ticket','external','asset','invalid'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && Number.isSafeInteger(disconnections) && disconnections >= 0 && Number.isSafeInteger(pageErrors) && pageErrors >= 0, 'IDLE_RUNTIME_METRICS')
  return { status: counts.data_api === 0 && counts.invalid === 0 && visibleStart && visibleEnd && liveStart && liveEnd
      && disconnections === 0 && pageErrors === 0 ? 'passed' : 'failed',
    windowMs: elapsedMs, clock: 'driver_monotonic', scope: 'visible_selfhost_browser_requests_not_sql_instrumentation',
    dataReadRequests: counts.data_api, infrastructureRequests: { version: counts.version, auth: counts.auth, liveTicket: counts.live_ticket },
    externalRequests: counts.external, assetRequests: counts.asset, invalidRequests: counts.invalid,
    pageVisibleAtStart: visibleStart, pageVisibleAtEnd: visibleEnd, liveConnectedAtStart: liveStart, liveConnectedAtEnd: liveEnd,
    liveDisconnections: disconnections, pageErrors, fetchPatched: false, requestInterception: false, explicitChatSubmissions: 0 }
}

async function captureQuotaNotice({ chromium, origin, botId, email, password, source, revision }) {
  check(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin) && UUID.test(botId)
    && /^[a-f0-9]{40}$/.test(revision), 'QUOTA_UI_SCOPE')
  const report = { status: 'failed', source: revision, browser: 'repository_Playwright_in_existing_Actions',
    localBrowserUnavailable: true, explicitChatSubmissions: 0, locales: [], cleanup: {} }
  let browser, context, signedIn = false, pageErrors = 0, consoleErrors = 0, consoleWarnings = 0, phase = 'launch'
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    context.setDefaultTimeout(30000)
    phase = 'email_login'
    const login = await context.request.post(origin + '/mikka/api/auth/sign-in/email', {
      headers: { origin }, data: { email, password }, timeout: 30000 })
    check(login.ok(), 'QUOTA_UI_LOGIN'); signedIn = true
    const page = await context.newPage()
    page.on('pageerror', () => { pageErrors++ })
    page.on('console', message => { if (message.type() === 'error') consoleErrors++; if (message.type() === 'warning') consoleWarnings++ })
    const liveSockets = new Set()
    let navigation = 0, idleCounts, idleDisconnections = 0, ready
    page.on('request', request => {
      if (idleCounts) idleCounts[idleRequestKind(request.url(), origin)]++
    })
    page.on('websocket', socket => {
      let url
      try { url = new URL(socket.url()) } catch { return }
      if (!['ws:','wss:'].includes(url.protocol) || url.host !== new URL(origin).host
        || !url.pathname.includes('/v1/live/') || !url.pathname.endsWith('/socket')) return
      const generation = navigation
      const opened = () => { if (generation === navigation) { liveSockets.add(socket); ready?.() } }
      socket.on('framesent', opened); socket.on('framereceived', opened)
      socket.on('close', () => { if (generation === navigation && liveSockets.delete(socket) && idleCounts) idleDisconnections++ })
    })
    for (const locale of ['en', 'zh-CN']) {
      phase = 'notice_' + locale
      const messages = JSON.parse(await readFile(source + '/messages/' + locale + '.json', 'utf8'))
      const notice = messages.RunErrors?.cloud_quota_exhausted?.default, topUp = messages.Settings?.cloud?.topUp
      check(typeof notice === 'string' && typeof topUp === 'string', 'QUOTA_UI_COPY')
      navigation++; liveSockets.clear()
      await page.goto(origin + '/mikka/' + locale + '/?bot=' + botId, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const location = new URL(page.url())
      check(location.origin === origin && location.searchParams.get('bot') === botId && /Mikka/i.test(await page.title()), 'QUOTA_UI_ORIGIN')
      if (locale === 'en') {
        // This account is created by this run and has never opened the app.
        // Complete its real first-run action; do not hide an overlay for proof.
        const skip = page.getByRole('button', { name: 'Skip setup', exact: true })
        await skip.waitFor({ state: 'visible' }); await skip.click(); await skip.waitFor({ state: 'hidden' })
      }
      await page.getByText(notice, { exact: true }).first().waitFor({ state: 'visible' })
      const link = page.getByRole('link', { name: topUp, exact: true })
      const links = await link.all()
      let billingLink = false
      for (const item of links) {
        const href = await item.getAttribute('href')
        if (!href) continue
        const url = new URL(href, origin)
        if (url.origin === origin && url.pathname === '/mikka/api/cloud/models/billing'
          && url.searchParams.get('redirect') === '1' && await item.isVisible()) billingLink = true
      }
      check(billingLink && pageErrors === 0 && consoleErrors === 0
        && !await page.locator('nextjs-portal').isVisible(), 'QUOTA_UI_NOTICE')
      const path = '.artifacts/self-hosting/quota-' + locale + '.png'
      await mkdir('.artifacts/self-hosting', { recursive: true })
      await page.screenshot({ path, animations: 'disabled' })
      report.locales.push({ locale, noticeVisible: true, billingLinkVisible: true, screenshot: path })
    }
    // Complement the separate fake-clock component suite with one real idle
    // minute on this running community instance. Observe requests passively;
    // never replace fetch, read bodies/headers, send a chat or instrument SQL.
    try {
      await page.bringToFront()
      await page.waitForLoadState('networkidle', { timeout: 30000 })
      await new Promise((resolveReady, reject) => {
        if (liveSockets.size) { resolveReady(); return }
        const timer = setTimeout(() => { ready = undefined; reject(Error('COMMUNITY_IDLE_LIVE_NOT_READY')) }, 45000)
        ready = () => { clearTimeout(timer); ready = undefined; resolveReady() }
      })
      const visibleStart = await page.evaluate(() => document.visibilityState === 'visible'), liveStart = liveSockets.size > 0
      const errorsStart = pageErrors, began = performance.now()
      idleCounts = { data_api: 0, version: 0, auth: 0, live_ticket: 0, external: 0, asset: 0, invalid: 0 }
      await new Promise(resolveIdle => setTimeout(resolveIdle, 60000))
      const counts = idleCounts; idleCounts = undefined
      report.liveIdleBudget = idleRuntimeReceipt({ elapsedMs: Math.floor(performance.now() - began), counts, visibleStart,
        visibleEnd: await page.evaluate(() => document.visibilityState === 'visible'), liveStart, liveEnd: liveSockets.size > 0,
        disconnections: idleDisconnections, pageErrors: pageErrors - errorsStart })
    } catch (error) {
      report.liveIdleBudget = { status: 'failed', code: /^COMMUNITY_IDLE_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_IDLE_RUNTIME_FAILED' }
    } finally { idleCounts = undefined }
    report.status = 'passed'
  } catch (error) {
    report.failure = { phase, code: /^COMMUNITY_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_QUOTA_UI_FAILED' }
  } finally {
    if (signedIn) { try {
      report.cleanup.sessionClosed = (await context.request.post(origin + '/mikka/api/auth/sign-out', {
        headers: { origin }, data: {}, timeout: 30000 })).ok()
    } catch { report.cleanup.sessionClosed = false } }
    try { await context?.close(); report.cleanup.contextClosed = true } catch { report.cleanup.contextClosed = false }
    try { await browser?.close(); report.cleanup.browserClosed = true } catch { report.cleanup.browserClosed = false }
    if (Object.values(report.cleanup).some(value => value === false)) report.status = 'failed'
    report.pageErrors = pageErrors
    report.consoleErrors = consoleErrors
    report.consoleWarnings = consoleWarnings
  }
  return report
}

const vaultNeed = (value, code) => { if (!value) throw Error('COMMUNITY_VAULT_' + code) }

export function vaultLogsContainPlaintext(logs, values) {
  vaultNeed(typeof logs?.stdout === 'string' && typeof logs?.stderr === 'string'
    && values.length === 2 && values.every(value=>typeof value==='string'&&value.length>0), 'LOG_STREAMS')
  return [logs.stdout,logs.stderr].some(text=>values.some(value=>text.includes(value)))
}

export async function runVaultAcceptance({ community, localPool, own, workspace, Sandbox, e2bKey,
  readAppLogs, appName, cloudflared, journalVm, journalComputer, releasedWorker }) {
  vaultNeed(UUID.test(workspace.id) && typeof own.id === 'string' && own.id.length > 0
    && /^mikka-community-[a-z0-9-]+-app$/.test(appName)
    && /^[a-f0-9]{40}$/.test(releasedWorker), 'FIXTURE_SCOPE')
  const existing = await localPool.query('SELECT 1 FROM cloud_machines WHERE "ownerId"=$1 AND "workspaceId"=$2', [own.id, workspace.id])
  vaultNeed(existing.rowCount === 0, 'EMPTY_MACHINE_SCOPE')
  // Record the unique empty-instance workspace before allocation, so the
  // independent cleanup can discover a VM after a lost allocation response.
  await journalComputer(workspace.id)
  let username = 'vault-' + randomBytes(12).toString('hex'), password = randomBytes(32).toString('base64url')
  let tunnel, server, botId, subagentId, credentialId, machineId, timer, submitted = 0, finish
  const receipt = { status: 'failed', savedThroughSettings: false, automaticSubagentLogin: false,
    modelRequestsRequired: false, screenshotsCaptured: false, logsContainPlaintext: null, cleanup: {} }
  const login = new Promise(resolve => { finish = resolve })
  try {
    server = createServer(async (request, response) => {
      // This fixture never prints request headers, bodies, cookies or values.
      try {
        if (request.method === 'GET' && request.url === '/login') {
          response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
          response.end('<!doctype html><title>Acceptance login</title><form method="post" action="/login"><label>Account<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>')
          return
        }
        if (request.method === 'POST' && request.url === '/login') {
          const chunks = []; let bytes = 0
          for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { response.writeHead(413); response.end(); return }; chunks.push(chunk) }
          const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          const valid = fields.get('username') === username && fields.get('password') === password
          if (!valid || ++submitted !== 1) { response.writeHead(403); response.end(); return }
          response.writeHead(303, { location: '/done', 'cache-control': 'no-store' }); response.end()
          finish({ accepted: true })
          return
        }
        if (request.method === 'GET' && request.url === '/done') {
          response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
          response.end('<!doctype html><title>Signed in</title><p>The disposable account signed in.</p>'); return
        }
        response.writeHead(404); response.end()
      } catch { response.destroy() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    tunnel = spawn(cloudflared, ['tunnel', '--url', 'http://127.0.0.1:' + server.address().port, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const website = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('COMMUNITY_VAULT_TUNNEL_TIMEOUT')), 30000)
      let text = ''
      const read = chunk => { text = (text + chunk).slice(-8192); const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (url && text.includes('Registered tunnel connection')) { clearTimeout(timeout); resolve(url[0]) } }
      tunnel.stdout.on('data', read); tunnel.stderr.on('data', read)
      tunnel.once('error', () => { clearTimeout(timeout); reject(Error('COMMUNITY_VAULT_TUNNEL_START')) })
    })
    const ready = await fetch(website + '/login', { signal: AbortSignal.timeout(20000), redirect: 'error' })
    vaultNeed(ready.ok, 'WEBSITE_READY'); await ready.body?.cancel()
    const saved = await community.rpc('settings-activity.saveSavedLogin', [{ site: website, account: username, password }])
    vaultNeed(UUID.test(saved.id) && saved.site === website, 'SETTINGS_SAVE'); credentialId = saved.id
    receipt.savedThroughSettings = true
    // Only this disposable instance receives the existing key, via its normal
    // owner settings action. It is never passed to the website or model.
    await community.rpc('workspace-secrets.saveE2BKey', [{ apiKey: e2bKey }, workspace.id])
    const bot = await community.json('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Vault acceptance ' + randomBytes(6).toString('hex') }) })
    botId = bot.id; vaultNeed(UUID.test(botId), 'BOT')
    const started = await community.json('/api/bots/' + botId + '/subagents', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Open ' + website + '/login and sign in with the saved account. Do not request, read, copy, or expose any credential. Do not perform any other operation.' }) })
    subagentId = started.subagentId; vaultNeed(UUID.test(subagentId), 'SUBAGENT')
    // The ordinary workflow's login detector and broker do the fill and submit
    // before its visual-planning step. The driver never calls the broker/CDP.
    const observed = await Promise.race([login, new Promise(resolve => { timer = setTimeout(() => resolve({ accepted: false }), 240000) })])
    vaultNeed(observed.accepted && submitted === 1, 'AUTOMATIC_LOGIN')
    receipt.automaticSubagentLogin = true
    const used = await community.rpc('settings-activity.listSavedLoginUsage', [credentialId])
    vaultNeed(used.uses?.some(row => row.subagentId === subagentId && row.botId === botId && ['input_inserted_guarded', 'password_submitted'].includes(row.result)), 'USAGE')
    const stored = await localPool.query('SELECT s.ciphertext,s.wrapped_dek FROM credential_secrets s WHERE s.credential_id=$1', [credentialId])
    vaultNeed(stored.rowCount === 1 && !JSON.stringify(stored.rows).includes(password), 'ENCRYPTED_STORE')
    receipt.status = 'passed'
  } catch (error) {
    receipt.code = /^COMMUNITY_VAULT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_VAULT_FLOW'
  } finally {
    clearTimeout(timer)
    if (subagentId && botId) {
      try { const stopped = await community.json('/api/bots/' + botId + '/subagents/' + subagentId + '/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); receipt.cleanup.subagentStopped = stopped.state === 'stopped' } catch { receipt.cleanup.subagentStopped = false }
    }
    // Include terminal/Stop events and their logs in the plaintext check.
    // No cloud model binding or model API key is installed during this case.
    try {
      const logs = await readAppLogs()
      receipt.logsContainPlaintext = vaultLogsContainPlaintext(logs,[password,username])
      vaultNeed(!receipt.logsContainPlaintext, 'APP_LOG_PLAINTEXT')
      if (subagentId) {
        const events = await localPool.query(`SELECT count(*)::int AS n,
          COALESCE(bool_and(strpos(event::text,$3)=0 AND strpos(event::text,$4)=0),false) AS clean
          FROM subagent_events WHERE "ownerId"=$1 AND "subagentId"=$2`, [own.id, subagentId, password, username])
        receipt.subagentEventRows = events.rows[0].n
        receipt.subagentEventsContainPlaintext = !events.rows[0].clean
        vaultNeed(receipt.subagentEventRows > 0 && !receipt.subagentEventsContainPlaintext, 'EVENT_LOG_PLAINTEXT')
      }
    } catch (error) {
      receipt.status = 'failed'
      receipt.code = /^COMMUNITY_VAULT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_VAULT_LOG_INSPECTION'
    }
    try {
      const rows = await localPool.query('SELECT "sandboxId" FROM cloud_machines WHERE "ownerId"=$1 AND "workspaceId"=$2', [own.id, workspace.id])
      vaultNeed(rows.rowCount <= 1, 'CLEANUP_MACHINE_SCOPE'); machineId = rows.rows[0]?.sandboxId
      if (machineId) {
        receipt.machineId = machineId
        vaultNeed(/^[a-z0-9]{10,100}$/.test(machineId), 'CLEANUP_MACHINE_ID'); await journalVm(machineId)
        try {
          const vm = await Sandbox.connect(machineId, { apiKey: e2bKey })
          receipt.workerMatches = (await vm.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim() === releasedWorker
          vaultNeed(receipt.workerMatches, 'WORKER_MISMATCH')
        } finally { await Sandbox.kill(machineId, { apiKey: e2bKey }); receipt.cleanup.vmKilled = true }
        try { await Sandbox.getInfo(machineId, { apiKey: e2bKey }); receipt.cleanup.vmAbsent = false } catch (error) { receipt.cleanup.vmAbsent = error?.name === 'SandboxNotFoundError' || error?.constructor?.name === 'SandboxNotFoundError' || error?.status === 404 }
      } else receipt.cleanup.vmAbsent = true
    } catch { receipt.cleanup.vmAbsent = false }
    if (credentialId) { try { await community.rpc('settings-activity.deleteSavedLogin', [credentialId]); receipt.cleanup.loginRevoked = true } catch { receipt.cleanup.loginRevoked = false } }
    try { await community.rpc('workspace-secrets.deleteE2BKey', [workspace.id]); receipt.cleanup.localE2BKeyRemoved = true } catch { receipt.cleanup.localE2BKeyRemoved = false }
    if (tunnel) {
      const exited = once(tunnel, 'exit').catch(() => null); tunnel.kill('SIGTERM')
      let exitTimer
      await Promise.race([exited, new Promise(resolve => { exitTimer = setTimeout(resolve, 5000) })]); clearTimeout(exitTimer)
      if (tunnel.exitCode === null && tunnel.signalCode === null) { tunnel.kill('SIGKILL'); await exited }
      receipt.cleanup.tunnelStopped = true
    }
    server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve))
    username = password = undefined
    if (Object.values(receipt.cleanup).some(value => value === false)) receipt.status = 'failed'
  }
  return receipt
}

// Production keeps these non-secret location selectors in its live deployment.
// Their effective access project and the normal custody identity decide the read.
export async function readProductionAccessLocation(read, readSource, report = {}) {
  const project = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
  const { envs } = await read('/v10/projects/' + project + '/env')
  check(Array.isArray(envs), 'SOURCE_CONFIG_METADATA')
  const keys = ['MIKKA_BYOS_INFISICAL_PROJECT', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT', 'MIKKA_BYOS_ACCESS_INFISICAL_PATH', 'MIKKA_BYOS_ACCESS_INFISICAL_PROJECT']
  const values = {}
  for (const key of keys) {
    const rows = envs.filter(row => row.key === key && row.target?.includes('production') && !row.gitBranch)
    check(rows.length <= 1 && (rows.length === 1 || key === 'MIKKA_BYOS_ACCESS_INFISICAL_PROJECT'), 'SOURCE_CONFIG_' + key)
    if (rows.length) {
      ;(report.sourceSelectorTypes ??= {})[key] = ['sensitive','secret','encrypted','plain','system'].includes(rows[0].type) ? rows[0].type : 'OTHER'
      values[key] = await readSource(key)
    }
  }
  const location = { project: values.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT || values.MIKKA_BYOS_INFISICAL_PROJECT,
    environment: values.MIKKA_BYOS_INFISICAL_ENVIRONMENT, path: values.MIKKA_BYOS_ACCESS_INFISICAL_PATH }
  report.sourceLocationShape = { projectIsUuid: UUID.test(location.project), environmentIsSlug: /^[a-zA-Z0-9_-]{1,32}$/.test(location.environment ?? ''), pathIsAbsolute: /^\/[a-zA-Z0-9/_-]{1,200}$/.test(location.path ?? ''), source: 'Infisical_prod_vercel_native_sync_source' }
  check(Object.entries(report.sourceLocationShape).every(([key, value]) => key === 'source' || value === true), 'SOURCE_CONFIG_SCOPE')
  return location
}

export async function readAuthorizedProjection({ location, name, clientId, clientSecret, report, fetcher = fetch }) {
  check(UUID.test(location?.project ?? '') && /^[a-zA-Z0-9_-]{1,32}$/.test(location?.environment ?? '')
    && /^\/[a-zA-Z0-9/_-]{1,200}$/.test(location?.path ?? '') && /^mikka-byos-[a-f0-9-]{36}$/.test(name ?? '')
    && typeof clientId === 'string' && clientId.length > 0 && typeof clientSecret === 'string' && clientSecret.length > 0, 'SOURCE_PROJECTION_SCOPE')
  const request = async (operation, path, init) => {
    let response
    try { response = await fetcher('https://app.infisical.com' + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
    catch { throw Error('COMMUNITY_SOURCE_PROJECTION_NETWORK') }
    ;(report.sourceRequests ??= []).push({ operation, status: response.status })
    check(response.ok, 'SOURCE_PROJECTION_HTTP_' + response.status)
    let value; try { value = await response.json() } catch { throw Error('COMMUNITY_SOURCE_PROJECTION_BODY') }
    return value
  }
  const login = await request('existing_custody_login', '/api/v1/auth/universal-auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) })
  check(login.tokenType === 'Bearer' && typeof login.accessToken === 'string' && login.accessToken.length > 0, 'SOURCE_IDENTITY')
  const query = new URLSearchParams({ projectId: location.project, environment: location.environment, secretPath: location.path,
    type: 'shared', version: '1', viewSecretValue: 'true', expandSecretReferences: 'false', includeImports: 'false' })
  const result = await request('authorized_access_projection', '/api/v4/secrets/' + name + '?' + query, {
    method: 'GET', headers: { authorization: 'Bearer ' + login.accessToken } })
  const secret = result.secret
  check(secret?.secretKey === name && secret.version === 1 && !secret.secretValueHidden
    && typeof secret.secretValue === 'string' && secret.secretValue.length > 0 && Buffer.byteLength(secret.secretValue) <= 32768, 'SOURCE_PROJECTION_SCHEMA')
  return secret.secretValue
}

// Use the ordinary shared-account action before taking the immutable snapshot.
// Near expiry, only the production custody service renews the provider grant.
export async function readCheckedSourceMetadata(client, connectionId, workspaceId, readMetadata, receipt = {}) {
  check(UUID.test(connectionId) && UUID.test(workspaceId), 'CHECKED_SOURCE_SCOPE')
  await client.rpc('model-order.checkModelOrderQuota', [connectionId, workspaceId])
  receipt.normalSourceCheck = true
  return readMetadata()
}

// Reuse the repository policy selector and this session's normal cookie jar.
// Only its verified private callback determines the subscription workspace.
export async function selectSharedTeam(client, ownerId, selector) {
  let workspaceId
  const proof = await selector({ ownerId,
    onSelected: selection => { workspaceId = selection.workspaceId },
    json: (path, body) => client.json(path.slice('/mikka'.length), body ? {
      ...post(body), headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' },
    } : undefined),
  })
  check(UUID.test(workspaceId ?? '') && proof?.teamWorkspaceConfirmed === true
    && proof.teamAdminMembershipVerified === true && proof.teamSelectionBasis === 'unique-active-admin-identity-match', 'TEAM_SCOPE')
  return { workspaceId, proof }
}

export async function configureBoundSubscription(client, workspaceId, selected, receipt = {}) {
  const change = async (step, value) => { receipt.modelSelectionStep = step; return client.rpc('model-order.changeModelOrder', [value, workspaceId]) }
  await change('location', { kind: 'location', location: 'local' })
  await change('auto-routing', { kind: 'autoRouting', enabled: false })
  await change('preferred', { kind: 'preferred', harness: selected.harness })
  // The first list mutation materializes every virtual default ID. Add first,
  // then read the stored IDs before removing any other row.
  await change('materialize', { kind: 'add', entries: [{ harness: selected.harness, model: selected.model, source: { kind: 'subscription', connectionId: selected.localConnection } }] })
  receipt.modelSelectionStep = 'read-materialized'
  const order = await client.rpc('model-order.getModelOrder', [workspaceId])
  const matches = entry => entry.harness === selected.harness && entry.model === selected.model && entry.source?.kind === 'subscription' && entry.source.connectionId === selected.localConnection
  check(order.entries.filter(matches).length === 1, 'BOUND_MODEL')
  for (const entry of order.entries.filter(entry => !matches(entry))) await change('remove-extra', { kind: 'remove', id: entry.id })
  receipt.modelSelectionStep = 'verify-bound'
  const fixed = await client.rpc('model-order.getModelOrder', [workspaceId])
  check(fixed.entries.length === 1 && matches(fixed.entries[0]) && fixed.location === 'local' && fixed.autoModelRouting === false, 'BOUND_MODEL')
  receipt.modelSelectionVerified = true
}

export function safeRepositoryFailure(value) {
  const text = typeof value === 'string' ? value.slice(0, 131072) : ''
  const patterns = {
    executable_missing: /\bENOENT\b|git: (?:not found|command not found)/i,
    filesystem_permission: /\bEACCES\b|permission denied/i,
    filesystem_full: /\bENOSPC\b|no space left on device/i,
    git_authentication: /authentication failed|could not read Username|terminal prompts disabled|invalid username or token/i,
    git_not_found: /repository not found|does not appear to be a git repository/i,
    tls_certificate: /SSL certificate problem|unable to get local issuer certificate|certificate verify failed/i,
    dns_failure: /could not resolve host|\bENOTFOUND\b|\bEAI_AGAIN\b/i,
    connection_failure: /failed to connect|connection reset|\bECONNRESET\b|\bECONNREFUSED\b/i,
    timeout: /timed out|\bETIMEDOUT\b|timeout of \d+/i,
    git_transport: /RPC failed|HTTP\/2 stream|early EOF|index-pack failed|invalid index-pack output/i,
    invalid_repository_path: /Invalid repository cache path|Repository cache escapes|Repository cache is not a standard clone|Repository cache contains a symlink/i,
    invalid_repository_url: /Invalid repository URL|Unsupported repository|Invalid run GitHub endpoint|Invalid prepared GitHub credential/i,
    git_ownership: /detected dubious ownership|unsafe repository/i,
    git_configuration: /invalid key|bad config|invalid config|too many entries|missing config value|bogus format/i,
    abort: /AbortError|operation was aborted|command was canceled/i,
  }
  const matched = /Command failed with exit code (\d{1,3})\b/.exec(text)
  return { categories: Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    exitCode: matched ? Number(matched[1]) : null }
}

// A failure may be a fixed product message outside the protocol registry.
// Match only literals present in the frozen public source and emit their
// source locations; never return the runtime message or its substitutions.
export function safeSourceFailures(value, signatures) {
  const text = typeof value === 'string' ? value.slice(0, 524288) : ''
  return signatures.filter(row => row.literal.length >= 8 && text.includes(row.literal))
    .slice(0, 24).map(row => ({ source: row.source, line: row.line }))
}

export function safeThreadFailure(detail, userCodes) {
  const extra = new Set(['binding_required','account_unavailable','binding_mismatch','stale_binding','pending_auth','reconnect_required','disconnected','quota_unknown','quota_exhausted','backend_unavailable','isolation_required','billing_unverified','subscription_rate_limited','provider_access_denied','provider_request_rejected','provider_temporarily_unavailable','invalid_credential_bundle','subscription_timeout','secret_store_unavailable','secret_not_found','credential_integrity_failed','ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','EPIPE'])
  const code = value => typeof value === 'string' && (Object.hasOwn(userCodes, value) || extra.has(value)) ? value : 'OTHER'
  const failure = detail.thread?.failureDetails
  const names = new Set(['Error','TypeError','CodedError','RunFailureError','WorkerRefusal','SubscriptionRefusal','TimeoutError','AbortError','CommandExitError'])
  return { status: ['queued','preparing','running','paused','waiting_input','failed','succeeded','completed','cancelled','stopped'].includes(detail.thread?.status) ? detail.thread.status : 'OTHER',
    code: code(failure?.code ?? detail.thread?.error),
    detail: failure?.code && userCodes[failure.code]?.includes(failure.detail) ? failure.detail : 'OTHER',
    causes: (Array.isArray(failure?.causes) ? failure.causes : []).slice(0, 8).map(cause => ({ name: names.has(cause.name) ? cause.name : 'OTHER', code: Number.isInteger(cause.code) && cause.code >= 0 && cause.code <= 599 ? cause.code : code(cause.code) })),
    repository: safeRepositoryFailure(detail.thread?.error),
    stages: (detail.chunks ?? []).flatMap(row => { const c = row.chunk; return c?.type === 'data-run-stage' && ['repository','worktree','agent_start'].includes(c.data?.stage) && typeof c.data.ok === 'boolean' ? [{ stage: c.data.stage, ok: c.data.ok }] : [] }) }
}

// Metadata only, kept outside artifacts so an independent always() step can
// remove exactly this run's access leaves and VMs after a driver timeout.
export function cleanupScope(value, run) {
  check(/^[1-9][0-9]{5,20}$/.test(run ?? '') && value.run === run && value.project === PROJECT
    && value.environment === 'dev' && value.path === '/release-selfhost-' + run && UUID.test(value.folder)
    && (value.nativeAllocation === undefined || typeof value.nativeAllocation === 'boolean')
    && Array.isArray(value.vms) && value.vms.length <= 3 && (!value.computerWorkspace || UUID.test(value.computerWorkspace)) && value.vms.every(id => /^[A-Za-z0-9_-]{8,128}$/.test(id)), 'CLEANUP_SCOPE')
  return value
}

export async function ownedComputerVMs(Sandbox, apiKey, workspaceId) {
  check(UUID.test(workspaceId), 'CLEANUP_COMPUTER_SCOPE')
  // This is a bounded provider inventory, not a business-data polling loop.
  const pages = Sandbox.list({ apiKey, limit: 4, query: { metadata: { application: 'mikka', workspaceId }, state: ['running', 'paused'] } })
  const values = await pages.nextItems()
  check(!pages.hasNext && values.length <= 3 && values.every(row => /^[a-z0-9]{10,100}$/.test(row.sandboxId)
    && row.metadata?.application === 'mikka' && row.metadata.workspaceId === workspaceId), 'CLEANUP_COMPUTER_INVENTORY')
  return values.map(row => row.sandboxId)
}

export async function ownedNativeVMs(Sandbox, apiKey, runId) {
  check(/^[1-9][0-9]{5,20}$/.test(runId ?? ''), 'CLEANUP_NATIVE_SCOPE')
  const pages = Sandbox.list({ apiKey, limit: 3,
    query: { metadata: { application: 'mikka-selfhost-release', runId }, state: ['running', 'paused'] } })
  const values = await pages.nextItems()
  check(!pages.hasNext && values.length <= 2 && values.every(row => /^[a-z0-9]{10,100}$/.test(row.sandboxId)
    && row.metadata?.application === 'mikka-selfhost-release' && row.metadata.runId === runId
    && ['claude', 'codex'].includes(row.metadata.kind)), 'CLEANUP_NATIVE_INVENTORY')
  return values.map(row => row.sandboxId)
}

export async function cleanupCommunity(env = process.env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === INFI.ref && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION')
  let value
  try { value = JSON.parse(await readFile(env.RUNNER_TEMP + '/mikka-community-cleanup.json', 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return; throw Error('COMMUNITY_CLEANUP_JOURNAL') }
  const owned = cleanupScope(value, env.GITHUB_RUN_ID), token = await login(env, [], fetch)
  const request = async (path, method = 'GET', body) => {
    const r = await fetch('https://app.infisical.com' + path, { method, signal: AbortSignal.timeout(20000), redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(r.ok, 'CLEANUP_HTTP_' + r.status); return r.status === 204 ? {} : r.json()
  }
  if (owned.vms.length || owned.computerWorkspace || owned.nativeAllocation) {
    const source = resolve(env.RUNNER_TEMP, 'mikka-community-source'), requireSource = createRequire(source + '/package.json')
    const { Sandbox } = await import(pathToFileURL(requireSource.resolve('e2b')))
    const secret = await request('/api/v4/secrets/E2B_API_KEY?' + new URLSearchParams({ projectId: PROJECT, environment: 'prod', secretPath: '/vercel', type: 'shared', viewSecretValue: 'true', expandSecretReferences: 'true', includeImports: 'false' }))
    const computerIds = owned.computerWorkspace ? await ownedComputerVMs(Sandbox, secret.secret.secretValue, owned.computerWorkspace) : []
    const nativeIds = owned.nativeAllocation ? await ownedNativeVMs(Sandbox, secret.secret.secretValue, env.GITHUB_RUN_ID) : []
    for (const id of new Set([...owned.vms, ...computerIds, ...nativeIds])) {
      try { await Sandbox.kill(id, { apiKey: secret.secret.secretValue }) } catch (error) { check(error?.status === 404 || error?.statusCode === 404 || error?.constructor?.name === 'SandboxNotFoundError', 'VM_CLEANUP') }
      try { await Sandbox.getInfo(id, { apiKey: secret.secret.secretValue }); check(false, 'VM_CLEANUP_UNCONFIRMED') }
      catch (error) { check(error?.status === 404 || error?.statusCode === 404 || error?.constructor?.name === 'SandboxNotFoundError', 'VM_CLEANUP_UNCONFIRMED') }
    }
    if (owned.computerWorkspace) check((await ownedComputerVMs(Sandbox, secret.secret.secretValue, owned.computerWorkspace)).length === 0, 'COMPUTER_CLEANUP_UNCONFIRMED')
    if (owned.nativeAllocation) check((await ownedNativeVMs(Sandbox, secret.secret.secretValue, env.GITHUB_RUN_ID)).length === 0, 'NATIVE_CLEANUP_UNCONFIRMED')
  }
  const folders = await request('/api/v2/folders?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', path: '/', recursive: 'true' }))
  const folder = folders.folders.find(f => f.id === owned.folder)
  if (folder) {
    check([folder.path, folder.relativePath].includes(owned.path), 'CLEANUP_FOLDER')
    const rows = await request('/api/v4/secrets?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', secretPath: owned.path,
      viewSecretValue: 'false', expandSecretReferences: 'false', includeImports: 'false', recursive: 'false' }))
    check(rows.secrets.length <= 2 && rows.secrets.every(s => s.secretPath === owned.path && /^mikka-byos-[a-f0-9-]{36}$/.test(s.secretKey)), 'CLEANUP_SECRET_SCOPE')
    for (const row of rows.secrets) await request('/api/v4/secrets/' + row.secretKey, 'DELETE', { projectId: PROJECT, environment: 'dev', secretPath: owned.path, type: 'shared' })
    await request('/api/v2/folders/' + owned.folder, 'DELETE', { projectId: PROJECT, environment: 'dev' })
  }
  console.log(JSON.stringify({ kind: 'community-independent-cleanup', run: env.GITHUB_RUN_ID, ownAccessFolderAbsent: true, knownVmReceipts: owned.vms.length, ownVmCount: 0, status: 'passed' }))
}

export function accessFixture(raw, row, target, now = Date.now()) {
  check(sha(raw) === row.accessDigest, 'SOURCE_DIGEST')
  const value = JSON.parse(raw)
  check(value.schema === 1 && value.ownerId === row.ownerId && value.workspaceId === row.workspaceId
    && value.connectionId === row.id && value.provider === row.provider, 'SOURCE_SCOPE')
  for (const payload of [value.payload, value.payload?.siwc].filter(Boolean)) {
    check(!('refresh_token' in payload) && !('id_token' in payload), 'ACCESS_ONLY')
  }
  check(typeof value.payload?.access_token === 'string' && Date.parse(value.payload.expired) >= now + 1_200_000, 'SOURCE_EXPIRY')
  check(UUID.test(target.workspaceId) && UUID.test(target.connectionId) && /^[A-Za-z0-9_-]{1,128}$/.test(target.ownerId), 'FIXTURE_SCOPE')
  value.ownerId = target.ownerId; value.workspaceId = target.workspaceId; value.connectionId = target.connectionId
  const encoded = JSON.stringify(value)
  return { value: encoded, digest: sha(encoded) }
}

// A provider-specific source/fixture failure cannot suppress the other path.
export async function independentProviders(providers, stage, work) {
  for (const provider of providers) {
    provider.receipt.stage = stage
    try { await work(provider) }
    catch (error) {
      Object.assign(provider.receipt, { status: 'failed',
        code: /^(COMMUNITY_[A-Z0-9_]+|startup_[a-z0-9_]{1,80})$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_PROVIDER_FAILED',
        errorClass: 'Error' })
    }
  }
}

export async function runCommunity(env = process.env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === INFI.ref && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION')
  check(env.MIKKA_COMMUNITY_MODE === undefined || env.MIKKA_COMMUNITY_MODE === 'native-delivery', 'ACCEPTANCE_MODE')
  const nativeOnly = env.MIKKA_COMMUNITY_MODE === 'native-delivery'
  assertCommunityAdmission(env)
  const source = resolve(env.RUNNER_TEMP, 'mikka-community-source')
  const requireSource = createRequire(source + '/package.json')
  const { Pool } = requireSource('pg')
  const { Sandbox } = await import(pathToFileURL(requireSource.resolve('e2b')))
  const { createSessionClient, readProductionWorkerRelease, watchRun, observeChunks, cleanupCase, restoreAcceptanceWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const { executionIdentitySchema, freezeExecutionIdentity, revalidateExecutionIdentity } = await import(pathToFileURL(source + '/lib/execution-identity.ts'))
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
  check(/^[a-f0-9]{40}$/.test(revision) && revision === env.MIKKA_COMMUNITY_REVISION, 'REVISION')
  const publicRevision = env.MIKKA_PUBLIC_REVISION || revision
  check(/^[a-f0-9]{40}$/.test(publicRevision), 'PUBLIC_REVISION')
  let releaseBinding
  try { releaseBinding = JSON.parse(await readFile('.artifacts/self-hosting/release-binding.json', 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT' || publicRevision !== revision) throw error
    releaseBinding = { revision, publicRevision, compatibility: communityReleaseCompatibility(revision, publicRevision) }
  }
  check(releaseBinding.revision === revision && releaseBinding.publicRevision === publicRevision
    && ['same_revision', 'mobile_documentation_or_locale', ...(nativeOnly ? ['independent_published_application_and_image'] : [])].includes(releaseBinding.compatibility?.kind), 'RELEASE_BINDING')
  const report = { kind: 'real-community-subscriptions', revision, candidate: env.MIKKA_COMMUNITY_CANDIDATE === '1', providerScope: env.MIKKA_COMMUNITY_PROVIDER ?? 'both', cases: [], cleanup: {}, stage: 'source', status: 'failed',
    publicRevision, releaseBinding, sourceRequests: [], credentialFixture: 'existing_authorized_access_projection', freshProviderOAuth: false, refreshGrantCopied: false, canonicalGrantPresent: false }
  const publicErrors = (await execute('git', ['grep', '-n', '-E', '(Error|Refusal)\\(|error:|summary:|msg:|reason:', '--', 'lib', 'app', 'packages/daemon/src', 'packages/protocol/src'], { cwd: source, maxBuffer: 8 * 1024 * 1024 })).stdout
  const signatures = publicErrors.split('\n').flatMap(line => {
    const location = /^([^:]+):(\d+):/.exec(line)
    return location && !/\.(test|spec)\./.test(location[1]) ? [...line.matchAll(/(?:(?:Error|CodedError|ActionFailureError|Refusal)\(|\b(?:error|summary|msg|reason):)\s*(['"])([^'"\n\\]{8,180})\1/g)]
      .map(match => ({ source: location[1], line: Number(location[2]), literal: match[2] })) : []
  })
  const name = 'mikka-community-' + env.GITHUB_RUN_ID
  const databasePassword = randomBytes(24).toString('hex'), key = randomBytes(32).toString('base64')
  const devPath = '/release-selfhost-' + env.GITHUB_RUN_ID
  const docker = async args => (await execute('docker', args, { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })).stdout.trim()
  let tunnel, privatePool, localPool, cloud, community, serverRegistered = false, infToken, infIssued = 0, ownFolder = false, sourceConfig, originalCloudWorkspace, originalCloudOwner
  const createdSecrets = [], sessions = [], resources = []
  const journal = { run: env.GITHUB_RUN_ID, project: PROJECT, environment: 'dev', path: devPath, folder: null, vms: [] }
  const saveJournal = () => writeFile(env.RUNNER_TEMP + '/mikka-community-cleanup.json', JSON.stringify(journal), { mode: 0o600 })
  const github = async (path, method = 'GET', body) => {
    check(env.GITHUB_TOKEN, 'DELIVERY_READER_REQUIRED')
    const response = await fetch('https://api.github.com/repos/alexj11324/Mikka' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: {
        accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GITHUB_TOKEN,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(response.ok, 'DELIVERY_HTTP_' + response.status)
    return response.status === 204 ? null : response.json()
  }
  const inf = async (path, method = 'GET', body) => {
    if (!infToken || Date.now() - infIssued > 600000) { infToken = await login(env, [], fetch); infIssued = Date.now() }
    const response = await fetch('https://app.infisical.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: 'Bearer ' + infToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(response.ok, 'INFISICAL_' + response.status)
    return response.status === 204 ? {} : response.json()
  }
  const secret = async (path, name, environment = 'prod', expand = true) => {
    const result = await inf('/api/v4/secrets/' + name + '?' + new URLSearchParams({ projectId: PROJECT, environment, secretPath: path,
      type: 'shared', viewSecretValue: 'true', expandSecretReferences: String(expand), includeImports: 'false', ...(!expand ? { version: '1' } : {}) }))
    check(typeof result.secret?.secretValue === 'string' && result.secret.secretKey === name, 'SECRET_SCHEMA')
    return result.secret.secretValue
  }
  try {
    infToken = await login(env, [], fetch); infIssued = Date.now()
    const [email, password, database, custodyId, custodySecret, e2bKey] = await Promise.all([
      secret('/', 'SMOKE_OWNER_EMAIL'), secret('/', 'SMOKE_OWNER_PASSWORD'), secret('/vercel', 'MIKKA_DATABASE_URL'),
      secret('/vercel', 'MIKKA_BYOS_CUSTODY_CLIENT_ID'), secret('/vercel', 'MIKKA_BYOS_CUSTODY_CLIENT_SECRET'), secret('/vercel', 'E2B_API_KEY'),
    ])
    smokeAccount({ SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password })
    cloud = createSessionClient(PUBLIC, manualRedirect)
    await cloud.json('/api/auth/sign-in/email', post({ email, password })); sessions.push(cloud)
    const identity = await cloud.json('/api/auth/get-session')
    check(identity.user?.email === email && identity.user.emailVerified === true, 'ACCOUNT')
    const currentRelease = await readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN })
    report.sharedWorkerAtStart = currentRelease.workerSha
    check(!nativeOnly || currentRelease.sourceCommit === env.MIKKA_COMMUNITY_RUNTIME_REVISION, 'APPROVED_RUNTIME_CHANGED')
    sourceConfig = currentRelease
    report.worker = { source: sourceConfig.sourceCommit, sha: sourceConfig.workerSha, templates: sourceConfig.templates }
    const expectedWorker = (await execute('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', revision], { cwd: source })).stdout.trim()
    check(expectedWorker === sourceConfig.workerSha, 'WORKER_VERSION')
    report.publicBuild = (await cloud.json('/api/version')).build
    const sharedBuilds = [publicRevision]
    check(sharedBuilds.includes(report.publicBuild), 'PUBLIC_VERSION')
    report.sharedControlPlaneCompatibility = releaseBinding.compatibility.kind
    privatePool = new Pool({ connectionString: database, max: 1, ssl: { rejectUnauthorized: true } })
    await privatePool.query('BEGIN READ ONLY')
    // The normal account API must expose the source before its exact metadata
    // can be read. No production row is inserted or modified.
    const initialWorkspace = await cloud.json('/api/workspace')
    check(UUID.test(initialWorkspace.workspace?.id ?? '') && initialWorkspace.currentUserId === identity.user.id, 'WORKSPACE_IDENTITY')
    originalCloudWorkspace = initialWorkspace.workspace.id; originalCloudOwner = identity.user.id
    const { selectTeamWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/team-workspace.mjs'))
    const team = await selectSharedTeam(cloud, identity.user.id, selectTeamWorkspace)
    report.team = team.proof
    const choices = [{ id: team.workspaceId, kind: 'team' }]
    const { api: vercelApi } = await import(pathToFileURL(source + '/scripts/e2b/publish-template-env.mjs'))
    const privateRelease = async () => {
      const alias = await vercelApi('/v4/aliases/mikka-cloud.vercel.app', { token: env.VERCEL_TEAM_TOKEN })
      const id = alias.deploymentId ?? alias.deployment?.id
      check((alias.projectId ?? alias.project?.id) === 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc'
        && /^dpl_[a-zA-Z0-9]{10,100}$/.test(id ?? ''), 'PRIVATE_DEPLOYMENT_ALIAS')
      const deployed = await vercelApi('/v13/deployments/' + id, { token: env.VERCEL_TEAM_TOKEN })
      check(deployed.projectId === 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc' && deployed.readyState === 'READY', 'PRIVATE_DEPLOYMENT_READY')
      // Never export the alias's protection bypass or deployment environment.
      return { id, state: 'READY', source: /^[a-f0-9]{40}$/.test(deployed.meta?.githubCommitSha ?? '') ? deployed.meta.githubCommitSha : null }
    }
    const productionLocation = await readProductionAccessLocation(path => vercelApi(path, { token: env.VERCEL_TEAM_TOKEN }), key => secret('/vercel', key), report)
    const [legacyPath, legacyEnvironment] = await Promise.all([secret('/vercel', 'MIKKA_BYOS_ACCESS_INFISICAL_PATH'), secret('/vercel', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT')])
    report.sourceConfiguration = { origin: 'existing_vercel_production', accessProjectMatchesLegacy: productionLocation.project === PROJECT,
      accessPathMatchesLegacy: productionLocation.path === legacyPath, environmentMatchesLegacy: productionLocation.environment === legacyEnvironment }
    const sources = []
    check(env.MIKKA_COMMUNITY_PROVIDER === 'claude' && env.MIKKA_COMMUNITY_CANDIDATE === '1' || !env.MIKKA_COMMUNITY_PROVIDER || env.MIKKA_COMMUNITY_PROVIDER === 'both', 'PROVIDER_SCOPE')
    const providers = [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']].filter(([provider]) => !env.MIKKA_COMMUNITY_PROVIDER || env.MIKKA_COMMUNITY_PROVIDER === 'both' || provider === env.MIKKA_COMMUNITY_PROVIDER).map(([provider, harness, model]) => {
      const receipt = { harness, model, status: 'failed', cleanup: {} }; report.cases.push(receipt)
      return { provider, harness, model, receipt }
    })
    await independentProviders(providers, 'source-authorization', async source => {
      const { provider, harness, model } = source
      let chosen, selectedWorkspace
      for (const workspace of choices.filter(w => w.kind === 'team')) {
        await cloud.rpc('workspace.switchWorkspace', [workspace.id])
        const view = await cloud.rpc('model-order.getModelOrder', [workspace.id])
        const candidates = (view.candidates ?? []).filter(c => c.harness === harness && c.model === model && c.source?.kind === 'subscription')
        if (candidates.length === 1) { chosen = candidates[0]; selectedWorkspace = workspace.id; break }
      }
      check(chosen, 'AUTHORIZED_' + provider.toUpperCase())
      const result = await readCheckedSourceMetadata(cloud, chosen.source.connectionId, selectedWorkspace, () => privatePool.query(`SELECT id::text,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","providerSubject","accessSecretName","accessDigest","modelCatalog",quota FROM byos_connections WHERE id=$1 AND provider=$2 AND state='connected'`, [chosen.source.connectionId, provider]), source.receipt)
      check(result.rows.length === 1, 'CONNECTION')
      const row = result.rows[0]
      check(UUID.test(row.id) && /^mikka-byos-[a-f0-9-]{36}$/.test(row.accessSecretName) && /^[a-f0-9]{64}$/.test(row.accessDigest), 'CONNECTION_METADATA')
      // Path/environment are the existing runtime configuration, never a
      // guessed canonical-grant path. Only the immutable access leaf is read.
      Object.assign(source.receipt, { sourceConnectionHash: sha(row.id).slice(0, 16), sourceCredentialVersion: Number(row.credentialVersion), sourceAccessNameHash: sha(row.accessSecretName).slice(0, 16) })
      if (report.sourceConfiguration.accessProjectMatchesLegacy && report.sourceConfiguration.accessPathMatchesLegacy && report.sourceConfiguration.environmentMatchesLegacy) {
        try { await secret(legacyPath, row.accessSecretName, legacyEnvironment, false); source.receipt.actionsOidcProjectionStatus = 200 }
        catch (error) { const match = /^COMMUNITY_INFISICAL_(\d{3})$/.exec(error?.message ?? ''); source.receipt.actionsOidcProjectionStatus = match ? Number(match[1]) : 'OTHER' }
      }
      const raw = await readAuthorizedProjection({ location: productionLocation, name: row.accessSecretName,
        clientId: custodyId, clientSecret: custodySecret, report })
      Object.assign(source, { row, raw, selectedWorkspace }); sources.push(source)
    })
    await privatePool.query('COMMIT'); await privatePool.end(); privatePool = undefined
    check(sources.length > 0, 'NO_AUTHORIZED_SOURCES')
    // This new folder must not be recursively exported by an existing Sync.
    const syncs = await inf('/api/v1/secret-syncs/vercel?projectId=' + PROJECT)
    check(syncs.secretSyncs.every(s => s.environment?.slug !== 'dev' || !(s.folder?.path === '/' && s.syncOptions?.includeAllSubFolders)), 'NO_DEV_EXPORT')
    const folders = await inf('/api/v2/folders?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', path: '/', recursive: 'true' }))
    check(!folders.folders.some(f => [f.path, f.relativePath].includes(devPath)), 'FRESH_FOLDER')
    const folder = await inf('/api/v2/folders', 'POST', { projectId: PROJECT, environment: 'dev', path: '/', name: devPath.slice(1) })
    check(folder.folder?.id, 'FOLDER_CREATED'); ownFolder = folder.folder.id; journal.folder = ownFolder; await saveJournal()
    report.stage = 'community-start'
    await docker(['network', 'create', name]); resources.push(['network', name])
    await docker(['run', '-d', '--name', name + '-pg', '--network', name, '-p', '127.0.0.1:55439:5432', '-e', 'POSTGRES_USER=mikka', '-e', 'POSTGRES_DB=community_release_e2e', '-e', 'POSTGRES_PASSWORD=' + databasePassword, 'postgres:17-alpine']); resources.push(['container', name + '-pg'])
    await docker(['run', '-d', '--name', name + '-mail', '--network', name, '-p', '127.0.0.1:58025:8025', 'axllent/mailpit:v1.27.4']); resources.push(['container', name + '-mail'])
    tunnel = spawn(env.RUNNER_TEMP + '/mikka-cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3000', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const origin = await new Promise((resolveReady, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('COMMUNITY_TUNNEL')), 45000)
      const data = chunk => { text = (text + chunk).slice(-64000); const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text); if (match && text.includes('Registered tunnel connection')) { clearTimeout(timer); resolveReady(match[0]) } }
      tunnel.stdout.on('data', data); tunnel.stderr.on('data', data); tunnel.on('error', () => reject(Error('COMMUNITY_TUNNEL')))
    })
    report.origin = origin
    const image = JSON.parse(await docker(['image','inspect','ghcr.io/alexj11324/mikka:' + revision]))[0]
    const imageEnv = Object.fromEntries((image?.Config?.Env ?? []).map(value => {
      const at=value.indexOf('='); return [value.slice(0,at),value.slice(at+1)]
    }))
    check(imageEnv.MIKKA_CLOUD_WORKER_SOURCE_COMMIT === revision
      && imageEnv.MIKKA_CLOUD_WORKER_SHA === expectedWorker
      && image?.Config?.Labels?.['org.opencontainers.image.revision'] === revision, 'IMAGE_RUNTIME_PINS')
    report.communityUi = nativeOnly ? 'not_opened_api_cli_only' : 'documented_compatibility_ui_explicitly_enabled'
    report.imageRuntime = { source:revision,workerSha:expectedWorker,imageId:image.Id,
      repositoryDigest:(image.RepoDigests ?? []).find(value=>value.startsWith('ghcr.io/alexj11324/mikka@sha256:')) ?? null,
      operatorRuntimeOverride:false }
    const appEnv = { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: key, WORKSPACE_SECRETS_KEY: key, CREDENTIAL_MASTER_KEY: key,
      DEVICE_GATEWAY_PUSH_SECRET: key, CRON_SECRET: key, MIKKA_EXTERNAL_CRON: '1', MIKKA_EDITION: 'community', ...(nativeOnly ? {} : { MIKKA_COMMUNITY_UI: '1' }),
      DATABASE_URL: `postgres://mikka:${databasePassword}@${name}-pg:5432/community_release_e2e`,
      MIKKA_DATABASE_URL: `postgres://mikka:${databasePassword}@${name}-pg:5432/community_release_e2e`,
      SMTP_URL: `smtp://${name}-mail:1025`, MIKKA_EMAIL_FROM: 'Mikka acceptance <login@selfhost.example.test>',
      MIKKA_BYOS_ENABLED: '1', MIKKA_BYOS_ENROLLMENT_ENABLED: '1', MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '1',
      MIKKA_BYOS_INFISICAL_ORIGIN: 'https://app.infisical.com', MIKKA_BYOS_INFISICAL_PROJECT: PROJECT,
      MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'dev', MIKKA_BYOS_INFISICAL_PATH: devPath + '-unused-custody',
      MIKKA_BYOS_ACCESS_INFISICAL_PATH: devPath, MIKKA_BYOS_CUSTODY_CLIENT_ID: custodyId, MIKKA_BYOS_CUSTODY_CLIENT_SECRET: custodySecret }
    const startApp = async () => {
      const original = {}; for (const [k, v] of Object.entries(appEnv)) { original[k] = process.env[k]; process.env[k] = v }
      try { await docker(['run', '-d', '--name', name + '-app', '--network', name, '-p', '127.0.0.1:3000:3000',
        '--mount', `type=volume,source=${name}-data,target=/data`, ...Object.keys(appEnv).flatMap(k => ['--env', k]), 'ghcr.io/alexj11324/mikka:' + revision]) }
      finally { for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
    }
    await startApp(); resources.push(['container', name + '-app'], ['volume', name + '-data'])
    // Bounded external service readiness; model/thread reads below use live push.
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await fetch(origin + '/mikka/api/version', { signal: AbortSignal.timeout(5000) }); ready = r.ok && (await r.json()).build === revision } catch { /* transport not ready */ }
      if (!ready) await new Promise(resolveReady => setTimeout(resolveReady, 2000))
    }
    check(ready, 'STARTUP')
    community = createSessionClient(origin, manualRedirect)
    // Same authorized shared account, independently registered on this empty
    // community installation. Verification mail is delivered to local Mailpit.
    const mailbox = new WebSocket('ws://127.0.0.1:58025/api/events'); await once(mailbox, 'open', { signal: AbortSignal.timeout(15000) })
    const mail = new Promise((resolveMail, reject) => {
      const timer = setTimeout(() => reject(Error('COMMUNITY_MAIL')), 30000)
      mailbox.onmessage = event => {
        for (const value of mailpitNotifications(event.data)) {
          if (value.Type === 'new' && typeof value.Data?.ID === 'string'
            && Array.isArray(value.Data.To) && value.Data.To.some(to => to?.Address === email)) {
            clearTimeout(timer); resolveMail(value.Data.ID)
          }
        }
      }
    })
    await community.json('/api/auth/sign-up/email', post({ name: 'Mikka release acceptance', email, password }))
    const message = await (await fetch('http://127.0.0.1:58025/api/v1/message/' + await mail)).json(); mailbox.close()
    const link = String(message.Text).match(/https:\/\/[^\s]+\/mikka\/api\/auth\/verify-email\?[^\s]+/)?.[0]
    check(link && new URL(link).origin === origin, 'VERIFICATION_LINK')
    const verified = await community.request(new URL(link).pathname.replace('/mikka', '') + new URL(link).search)
    check(verified.status === 302, 'VERIFICATION')
    const nativeLogin = await community.request('/api/auth/sign-in/email', post({ email, password }))
    check(nativeLogin.ok, 'NATIVE_LOGIN')
    const nativeBearer = nativeLogin.headers.get('set-auth-token'); await nativeLogin.body?.cancel(); sessions.push(community)
    check(typeof nativeBearer === 'string' && nativeBearer.length >= 32 && nativeBearer.length <= 512, 'NATIVE_BEARER')
    const nativeRpc = await fetch(origin + '/mikka/api/desktop/rpc', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { origin, authorization: 'Bearer ' + nativeBearer, 'content-type': 'application/json', 'x-mikka-client': 'desktop', 'x-mikka-desktop-protocol': '1' },
      body: JSON.stringify({ version: 1, action: 'agents.listAgents', args: [] }) })
    check(nativeRpc.ok && (await nativeRpc.json()).ok === true, 'NATIVE_RPC')
    report.nativeSession = { signedBearerAccepted: true, cookiesSent: false, status: nativeRpc.status, action: 'agents.listAgents', hasSignaturePadding: nativeBearer.endsWith('=') }

    const own = (await community.json('/api/auth/get-session')).user
    check(own.email === email && own.emailVerified === true, 'COMMUNITY_IDENTITY')
    const workspace = (await community.json('/api/workspace')).workspace
    localPool = new Pool({ connectionString: `postgres://mikka:${databasePassword}@127.0.0.1:55439/community_release_e2e`, max: 2 })
    // Temporary observation in this isolated disposable database only. Keep
    // no SQL text or arguments: classify the real stop writer and retain its
    // query fingerprint. The trigger never changes the run being observed.
    await localPool.query(`CREATE TABLE release_control_audit ("runId" uuid NOT NULL,kind text NOT NULL,fingerprint text NOT NULL,
      "leaseChanged" boolean NOT NULL,"observedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE FUNCTION release_control_observe() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE q text := current_query();
      BEGIN
        IF OLD."stopRequestedAt" IS NULL AND NEW."stopRequestedAt" IS NOT NULL THEN
          INSERT INTO release_control_audit("runId",kind,fingerprint,"leaseChanged") VALUES(NEW.id,
            CASE WHEN q LIKE '%factory_attempts%' THEN 'factory_attempts'
              WHEN q LIKE '%thread_machines%' THEN 'thread_machine'
              WHEN q LIKE '%deviceTokenId%' THEN 'device_token'
              WHEN q LIKE '%model_api_key_runs%' THEN 'model_key'
              WHEN q LIKE '%leaseExpiresAt%' THEN 'lease_mutation' ELSE 'run_control' END,
            md5(q),NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt");
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER release_control_observer AFTER UPDATE OF "stopRequestedAt" ON agent_runs
        FOR EACH ROW EXECUTE FUNCTION release_control_observe()`)
    appEnv.MIKKA_SERVER_ADMIN_USER_IDS = own.id
    await docker(['rm', '-f', '-v', name + '-app']); await startApp()
    for (let i = 0; i < 30; i++) { try { if ((await community.json('/api/version')).build === revision) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
    try { report.communityMonitoring = await inspectCommunityMonitoring(origin, key) }
    catch { report.communityMonitoring = { status: 'failed', code: 'COMMUNITY_MONITOR_FAILED' } }
    try {
      const status = await community.json('/api/github/manifest')
      check(status.admin === true && status.configured === false, 'MANIFEST_ADMIN')
      const prepared = await community.json('/api/github/manifest', post({}))
      const { GITHUB_APP_MANIFEST_TEMPLATE: template } = await import(pathToFileURL(source + '/lib/github/manifest-template.ts'))
      const action = new URL(prepared.action)
      check(action.origin === 'https://github.com' && action.pathname === '/settings/apps/new' && action.searchParams.has('state')
        && isDeepStrictEqual(prepared.manifest.default_permissions, template.permissions)
        && isDeepStrictEqual(prepared.manifest.default_events, [...template.events])
        && prepared.manifest.hook_attributes.url === origin + '/mikka/api/webhooks/github'
        && prepared.manifest.redirect_url === origin + '/mikka/api/github/manifest/callback'
        && prepared.manifest.public === false, 'MANIFEST_TEMPLATE')
      report.githubManifest = { status: 'passed', permissions: Object.keys(template.permissions).length, events: template.events.length,
        authenticatedOperator: true, ownOriginAndState: true, githubAppEnvironmentProvided: false, appCreated: false }
    } catch (error) { report.githubManifest = { status: 'failed', code: /^COMMUNITY_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_MANIFEST_REQUEST' } }
    report.stage = 'normal-cloud-binding'
    report.privateCloudAtStart = await privateRelease()
    await community.json('/api/cloud/connect', post({ action: 'register', name: 'Mikka community release ' + env.GITHUB_RUN_ID })); serverRegistered = true
    const bindCloud = async (scopes, selectWorkspace) => {
      const binding = await community.json('/api/cloud/connect', post({ action: 'bind', scopes }))
      check(typeof binding.url === 'string' && new URL(binding.url).origin === PUBLIC, 'BINDING_URL')
      const consent = await cloud.request(binding.url.slice(PUBLIC.length + '/mikka'.length))
      const bootstrap = /id="cloud-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(await consent.text())
      check(bootstrap, 'CLOUD_CONSENT')
      const model = JSON.parse(bootstrap[1]).model, selected = selectWorkspace(model.workspaces)
      check(selected && UUID.test(selected.id), 'CLOUD_WORKSPACE')
      const approved = await cloud.request('/cloud/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: model.requestId, csrf_token: model.csrfToken, workspace_id: selected.id, approve: 'true' }) })
      check(approved.status === 302, 'CLOUD_APPROVAL')
      const callback = new URL(approved.headers.get('location')); check(callback.origin === origin, 'CALLBACK_ORIGIN')
      const bound = await community.request(callback.pathname.slice('/mikka'.length) + callback.search)
      check(bound.status === 303, 'CLOUD_CALLBACK')
      const serverId = new URL(binding.url).searchParams.get('client_id')
      check(UUID.test(serverId), 'CLOUD_SERVER_ID')
      return { serverId, workspaceId: selected.id }
    }
    await bindCloud(['github'], workspaces => workspaces.find(w => w.kind === 'personal'))
    report.cloudBinding = true
    const installation = selectOfficialInstallation((await cloud.json('/api/integrations/github')).repositories)
    const installing = await community.request('/api/integrations/github/install')
    check(installing.status === 302, 'GITHUB_PREPARATION')
    const installUrl = new URL(installing.headers.get('location'))
    check(installUrl.origin === 'https://github.com' && installUrl.searchParams.has('state'), 'GITHUB_STATE')
    const setup = await cloud.request('/cloud/v1/github/setup?' + new URLSearchParams({ installation_id: String(installation), setup_action: 'install', state: installUrl.searchParams.get('state') }))
    check(setup.status === 302, 'GITHUB_SETUP')
    check((await community.json('/api/integrations/github')).repositories?.some(r => r.fullName === 'alexj11324/Mikka' && r.installationId === installation), 'COMMUNITY_GITHUB')
    report.githubPreparation = true
    // Verify the real delivery document without requiring the worktree to stay
    // empty: these threads must commit, push and open a draft PR.
    const verifyCommand = `node -e "if(!require('node:fs').readFileSync('README.md','utf8').trim())process.exit(1)" && git diff --exit-code && git diff --cached --exit-code`
    const verification = await community.json('/api/integrations/github/repositories/verification', { ...post({ repository: 'alexj11324/Mikka', verifyCommand }), method: 'PATCH' })
    check(verification.verifyCommand === verifyCommand, 'VERIFICATION_COMMAND')
    report.stage = 'subscription-fixtures'
    await independentProviders(sources, 'subscription-fixture', async s => {
      const connectionId = randomUUID(), secretName = 'mikka-byos-' + randomUUID()
      const fixture = accessFixture(s.raw, s.row, { ownerId: own.id, workspaceId: workspace.id, connectionId })
      await inf('/api/v4/secrets/' + secretName, 'POST', { projectId: PROJECT, environment: 'dev', secretPath: devPath, type: 'shared', secretValue: fixture.value }); createdSecrets.push(secretName)
      const normalRead = await readAuthorizedProjection({ location: { project: PROJECT, environment: 'dev', path: devPath }, name: secretName,
        clientId: custodyId, clientSecret: custodySecret, report: s.receipt })
      check(sha(normalRead) === fixture.digest, 'FIXTURE_NORMAL_IDENTITY_READ')
      s.receipt.fixtureNormalIdentityVerified = true
      // Connected metadata requires a grant reference even for this bounded
      // access-only fixture. Its deliberately absent grant cannot resolve in
      // the unused custody path; no canonical or refresh grant is created.
      const absentGrant = 'mikka-byos-' + randomUUID()
      await localPool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","providerSubject","accessSecretName","accessDigest","modelCatalog",quota,"secretName","secretDigest") VALUES ($1,$2,$3,$4,'connected',1,1,$5,$6,$7,$8,$9,$10,$11)`,
        [connectionId, own.id, workspace.id, s.provider, s.row.providerSubject, secretName, fixture.digest, JSON.stringify({ revision: '1', models: [s.model] }), s.row.quota, absentGrant, sha('absent-canonical-grant:' + connectionId)])
      await localPool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,'catalogue',$4,1,$5,$6)`, [randomUUID(), own.id, workspace.id, connectionId, s.provider + '_cpa', s.model])
      s.localConnection = connectionId; s.ready = true; delete s.raw
    })
    check(sources.some(s => s.ready), 'NO_READY_SOURCES')
    // Obtain a genuine local MCP OAuth token through DCR, PKCE and consent.
    report.stage = 'mcp-oauth'
    const redirect = origin + '/mikka/release-mcp-callback'
    const client = await community.json('/api/auth/oauth2/register', post({ client_name: 'Mikka release ' + env.GITHUB_RUN_ID, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'mikka' }))
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('base64url')
    const authQuery = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirect, scope: 'mikka', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: origin + '/mikka/api/mcp' })
    const authorize = await community.request('/api/auth/oauth2/authorize?' + authQuery)
    check(authorize.status === 302 || authorize.status === 200, 'MCP_AUTHORIZE')
    const consentLocation = authorize.status === 302 ? authorize.headers.get('location') : (await authorize.json()).url
    const localConsent = new URL(consentLocation, origin)
    check(localConsent.origin === origin && localConsent.pathname.endsWith('/oauth/consent')
      && localConsent.searchParams.has('sig') && localConsent.searchParams.get('state') === state, 'MCP_SIGNED_CONSENT')
    // The official oauthProviderClient normally adds the signed page query.
    // Send exactly that query with the ordinary consent request.
    const agreed = await community.json('/api/auth/oauth2/consent', post({ accept: true, oauth_query: localConsent.search.slice(1) }))
    const returned = new URL(agreed.url); check(returned.origin === origin && returned.searchParams.get('state') === state && returned.searchParams.has('code'), 'MCP_CONSENT')
    const exchanged = await community.json('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: returned.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mikka/api/mcp' }) })
    check(exchanged.access_token?.startsWith('mka_'), 'MCP_TOKEN')
    let sequence = 0, mcpTools
    const mcp = async (method, params) => {
      const scopedParams = method === 'tools/call'
        ? nativeMcpParameters(params, workspace.id, mcpTools) : params
      const response = await fetch(origin + '/mikka/api/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000), headers: {
        authorization: 'Bearer ' + exchanged.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: scopedParams }) })
      check(response.ok, 'MCP_HTTP_' + response.status)
      const eventStream = response.headers.get('content-type')?.includes('text/event-stream')
      const text = await response.text(), answer = eventStream ? JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).at(-1).slice(5)) : JSON.parse(text)
      if (answer.error || answer.result?.isError) {
        (report.mcpRefusals ??= []).push({ method: method === 'tools/call' ? 'tools/call' : 'other',
          tool: ['create_issue','dispatch_run'].includes(params?.name) ? params.name : null,
          code: Number.isSafeInteger(answer.error?.code) ? answer.error.code : null, toolError: answer.result?.isError === true })
        check(false,'MCP_RESULT')
      }
      return answer.result?.structuredContent ?? (answer.result?.content?.[0]?.text ? JSON.parse(answer.result.content[0].text) : answer.result)
    }
    await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mikka-community-release', version: '1.0.0' } })
    mcpTools = (await mcp('tools/list', {})).tools
    // Validate the two required catalogue entries before any VM allocation.
    report.mcpCatalogue = Object.fromEntries(['create_issue','dispatch_run'].map(name => {
      const value = nativeMcpParameters({name,arguments:{}},workspace.id,mcpTools)
      return [name,{workspaceArgumentDeclared:Object.hasOwn(value.arguments,'workspaceId')}]
    }))
    for (const s of sources.filter(source => source.ready)) {
      const row = s.receipt
      let sandbox, deviceId, runId, issueId, executionRecord, task
      try {
        report.stage = 'thread-' + s.provider
        row.stage = 'source-authorization'
        const authorization = await cloud.rpc('model-order.getModelOrder', [s.selectedWorkspace])
        check(authorization.candidates?.some(c => c.harness === s.harness && c.model === s.model
          && c.source?.kind === 'subscription' && c.source.connectionId === s.row.id), 'SOURCE_STILL_AUTHORIZED')
        row.stage = 'helper-preflight'
        const helper = communityDaemonHelper(await readFile(source + '/scripts/e2b/acceptance-daemon.mts', 'utf8'), origin)
        row.daemonLaunch = { mode: 'normal_personal_startDaemon', helperSourceBlob: 'bf546a0ef670b41f273d9f4c2e391220cfb6837c',
          officialBinaryGuardPreserved: true, candidatePublicationClaimed: false }
        row.stage = 'machine'
        assertCommunityAdmission(env)
        const kind = s.provider === 'claude' ? 'claude' : 'codex'
        // Persist intent before allocation: a lost create response still has
        // an exact run/kind metadata namespace for the always() cleanup.
        journal.nativeAllocation = true; await saveJournal()
        sandbox = await Sandbox.create(sourceConfig.templates[kind], { apiKey: e2bKey, timeoutMs: 900000, metadata: { application: 'mikka-selfhost-release', runId: env.GITHUB_RUN_ID, kind } })
        journal.vms.push(sandbox.sandboxId); await saveJournal()
        check((await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim() === sourceConfig.workerSha, 'VM_WORKER')
        row.vmWorkerVerified = true
        await sandbox.files.write('/opt/mikka/worker/scripts/e2b/community-acceptance-daemon.mts', helper, { user: 'root' })
        row.stage = 'enrollment'
        const grant = await community.json('/api/devices/enrollment', post({}))
        await sandbox.commands.run('install -d -m 700 /run/mikka-template-acceptance', { user: 'root', timeoutMs: 10000 })
        await sandbox.files.write('/run/mikka-template-acceptance/enrollment', grant.token, { user: 'root' })
        const proof = await new Promise(async (resolveReady, reject) => {
          let buffer = ''; const timer = setTimeout(() => reject(Error('COMMUNITY_DEVICE_READY')), 90000)
          try {
            const child = await sandbox.commands.run('cat /run/mikka-template-acceptance/enrollment | runuser -u user -- env PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin MIKKA_ACCEPTANCE_ORIGIN=' + origin + ' MIKKA_ACCEPTANCE_HARNESS=' + s.harness + ' /opt/mikka/worker/packages/daemon/node_modules/.bin/tsx /opt/mikka/worker/scripts/e2b/community-acceptance-daemon.mts', {
              user: 'root', background: true, timeoutMs: 0, onStdout: text => { buffer = (buffer + text).slice(-65536); const match = /^mikka-template-device (\{[^\r\n]+\})$/m.exec(buffer); if (match) { clearTimeout(timer); resolveReady(JSON.parse(match[1])) } }, onStderr() {} })
            void child.wait().then(() => { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_EXIT')) }, () => { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_EXIT')) })
          } catch { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_START')) }
        })
        check(UUID.test(proof.deviceId) && proof.harness === s.harness && /^[a-f0-9]{64}$/.test(proof.binarySha256), 'OFFICIAL_PROOF')
        deviceId = proof.deviceId; row.officialCli = { version: proof.version, binarySha256: proof.binarySha256 }; row.workerSha = sourceConfig.workerSha
        row.stage = 'agents'
        const agents = await community.rpc('agents.listAgents', []), agent = agents.find(a => a.deviceId === deviceId && a.harness === s.harness)
        check(agent, 'AGENT')
        row.stage = 'model-selection'
        await configureBoundSubscription(community, workspace.id, s, row)
        const sampleId = randomUUID(), marker = 'STARTUP_OK_' + sampleId
        row.stage = 'create-issue'
        const title = 'Self-hosted ' + kind + ' release validation'
        task = deliveryTask(env.GITHUB_RUN_ID, kind, revision)
        row.deliveryTarget = { branch: task.branch, file: task.path }
        const issue = await mcp('tools/call', { name: 'create_issue', arguments: { title, body: task.request + ' After the PR exists, reply exactly ' + marker + '.', priority: 'low' } })
        issueId = issue.issue?.id ?? issue.id; check(UUID.test(issueId), 'ISSUE')
        row.stage = 'dispatch'
        const dispatchStarted = performance.now()
        row.startupObservation = { clock: 'driver_monotonic_observation_upper_bound', calledAt: new Date().toISOString(), underFiveSecondTargetAsserted: false }
        const queued = await mcp('tools/call', { name: 'dispatch_run', arguments: { issueId, agentId: agent.id, repo: 'alexj11324/Mikka', requestKey: 'selfhost:' + sampleId, note: 'Use exactly ' + s.model + ' on this subscription. ' + task.request + ' Finish with ' + marker } })
        row.startupObservation.dispatchAcknowledgedAfterMs = Math.ceil(performance.now() - dispatchStarted)
        runId = queued.runId ?? queued.thread?.runId; check(UUID.test(runId), 'RUN')
        const initialFactory = (await localPool.query(`SELECT t."sourceEventId" FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
          WHERE a."runId"=$1 AND t."userId"=$2`, [runId, own.id])).rows[0]
        check(UUID.test(initialFactory?.sourceEventId ?? ''), 'FACTORY_SOURCE')
        const acceptedEpochHash = sha(initialFactory.sourceEventId).slice(0, 16)
        row.acceptedEpochHash = acceptedEpochHash
        const record = executionRecord = { runId, issueId, title, sampleId, harness: s.harness, requireReply: true, requireReplyAfterTool: true, requireTerminal: true, minToolCalls: 1 }
        row.runId = runId; row.issueId = issueId
        row.stage = 'full-thread'
        row.authorityReads = []
        const readAuthority = async () => {
          const tx = await localPool.connect(), reads = []
          try {
            await tx.query('BEGIN READ ONLY')
            const query = { query: async (text, values) => {
              const result = await tx.query(text, values)
              reads.push({ kind: text.includes('byos_bindings') ? 'subscription' : text.includes('FROM devices') ? 'device' : text.includes('mikka_workspace_members') ? 'membership' : text.includes('FROM bots') ? 'bot' : 'other', rows: result.rowCount })
              return result
            } }
            const run = (await tx.query('SELECT "userId","botId","deviceId","agentDefinition",status,"stopRequestedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3', [runId, own.id, deviceId])).rows[0]
            check(run, 'OWN_AUTHORITY_DIAGNOSIS')
            const item = { status: run.status, stopRequested: Boolean(run.stopRequestedAt), leaseExpired: Boolean(run.leaseExpiresAt) && new Date(run.leaseExpiresAt).getTime() <= Date.now(), reads }
            row.authorityReads.push(item)
            const subscription = run.agentDefinition?.subscription
            if (subscription) {
              const binding = (await tx.query(`SELECT b."ownerId",b."modelId",b.route,b."connectionRevision"::text AS revision,c.epoch::text AS epoch,c.state,c.paused
                FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" WHERE b.id=$1`, [subscription.bindingId])).rows[0]
              item.subscription = { present: Boolean(binding), connected: binding?.state === 'connected', paused: binding?.paused === true,
                revisionMatches: Boolean(binding && binding.revision === binding.epoch), modelMatches: binding?.modelId === subscription.modelId,
                routeMatches: binding?.route === subscription.route, ownerMatches: binding?.ownerId === run.userId }
            }
            try {
              const frozen = executionIdentitySchema.parse(run.agentDefinition.executionIdentity)
              const current = await freezeExecutionIdentity(query, run, query, frozen.workspaceId)
              item.changedFields = Object.keys(frozen).filter(key => !isDeepStrictEqual(frozen[key], current[key]))
              await revalidateExecutionIdentity(query, run, query)
              item.valid = true
            } catch (error) { item.valid = false; item.errorClass = ['ExecutionIdentityError','ZodError','TypeError'].includes(error?.name) ? error.name : 'OTHER' }
          } finally { await tx.query('ROLLBACK'); tx.release() }
        }
        const diagnosed = new Set()
        await watchRun(community, record, 480000, WebSocket, Date.now, undefined, { observe: async detail => {
          const key = detail.thread?.status
          if (!diagnosed.has(key) && diagnosed.size < 4) { diagnosed.add(key); await readAuthority() }
          const observed = observeChunks(record, detail, Date.now())
          if (record.agentStart && row.startupObservation.agentStartObservedAfterMs === undefined) row.startupObservation.agentStartObservedAfterMs = Math.ceil(performance.now() - dispatchStarted)
          if (record.firstProviderChunk && row.startupObservation.firstProviderChunkObservedAfterMs === undefined) row.startupObservation.firstProviderChunkObservedAfterMs = Math.ceil(performance.now() - dispatchStarted)
          return observed
        } })
        check(['succeeded', 'completed'].includes(record.lastStatus) && record.replyVerifiedAfterTool && record.toolCalls.some(t => t.outcome === 'ok'), 'THREAD_COMPLETE')
        check(['repository','worktree','agent_start'].every(stage => record.stages?.some(item => item.stage === stage && item.ok)), 'DELIVERY_CLONE_STAGES')
        row.stages = record.stages
        const pulls = await github('/pulls?' + new URLSearchParams({ head: 'alexj11324:' + task.branch, state: 'open' }))
        check(Array.isArray(pulls) && pulls.length === 1 && Number.isSafeInteger(pulls[0].number), 'DELIVERY_PR_COUNT')
        const files = await github('/pulls/' + pulls[0].number + '/files')
        row.delivery = deliveryReceipt(task, pulls, files)
        row.stage = 'github-cleanup'
        Object.assign(row.cleanup, await cleanupDelivery(task, pulls, files, github))
        row.stage = 'provenance'
        const evidence = (await community.json('/api/runs/' + runId + '/evidence')).run
        check(evidence.model === s.model && evidence.credentialType === 'subscription' && evidence.harness === s.harness
          && evidence.executionIdentity?.resourceBindings?.some(r => r.kind === 'device' && r.id === deviceId), 'RUN_PROVENANCE')
        const finalFactory = (await localPool.query(`SELECT t."sourceEventId",a.reason FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
          WHERE a."runId"=$1 AND t."userId"=$2`, [runId, own.id])).rows[0]
        check(finalFactory && sha(finalFactory.sourceEventId).slice(0, 16) === acceptedEpochHash
          && !/Superseded by an authenticated owner request/.test(finalFactory.reason ?? ''), 'ACCEPTED_EPOCH_REPLAYED')
        Object.assign(row, { status: 'passed', runId, issueId, successfulTool: true, replyAfterTool: true, terminal: record.lastStatus,
          replySource: record.replySource === 'submitted_report' ? 'submitted_report' : 'assistant_text',
          credentialType: evidence.credentialType, subscriptionRoute: evidence.subscriptionRoute, acceptedEpochPreserved: true })
      } catch (error) {
        row.code = /^(COMMUNITY_[A-Z0-9_]+|startup_[a-z0-9_]{1,80})$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_THREAD_FAILED'; row.errorClass = error?.constructor?.name === 'CommandExitError' ? 'CommandExitError' : 'Error'
        if (runId && issueId) {
          try {
            const heartbeat = JSON.parse(await sandbox.files.read('/home/user/.mikka/template-acceptance/heartbeat-proof.json', { user: 'root' }))
            row.heartbeatProof = heartbeat.map(value => ({ reported: value.reported, renewed: value.renewed, revoked: value.revoked, reportedRevoked: value.reportedRevoked }))
          } catch { row.heartbeatProofUnavailable = true }
          try {
            const journal = JSON.parse(await sandbox.files.read('/home/user/.mikka/template-acceptance/runs.json', { user: 'root' }))
            const local = journal.runs?.[runId]
            row.daemonRepository = safeRepositoryFailure(local?.error)
            row.daemonSourceFailures = safeSourceFailures(local?.error, signatures)
            row.daemonState = ['queued','preparing','running','paused','waiting_input','finishing','succeeded','failed','cancelled','stopped'].includes(local?.state) ? local.state : 'OTHER'
            row.daemonStopReason = ['submitted','error','cancelled','blocked','device_lost','lease_expired','quota','asked_human','provider_failure'].includes(local?.stopReason) ? local.stopReason : 'OTHER'
            row.daemonAssignment = { remoteIsExpected: local?.assignment?.remoteUrl === 'https://github.com/alexj11324/Mikka.git',
              githubEndpointMatchesServer: typeof local?.assignment?.github?.endpoint === 'string' && new URL(local.assignment.github.endpoint).origin === origin,
              modelCredentialWithheld: local?.credentialWithheld === true }
          } catch { row.daemonDiagnosisUnavailable = true }
          try {
            const log = await sandbox.files.read('/home/user/.mikka/template-acceptance/logs/daemon.log', { user: 'root' })
            row.daemonLogFailureClasses = safeRepositoryFailure(log)
            row.daemonLogSourceFailures = safeSourceFailures(log, signatures)
          } catch { row.daemonLogUnavailable = true }
          try {
            const ownRun = (await localPool.query('SELECT status,error,report FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3', [runId, own.id, deviceId])).rows[0]
            row.serverSourceFailures = safeSourceFailures(JSON.stringify(ownRun), signatures)
            row.serverErrorClasses = safeRepositoryFailure(ownRun?.error)
          } catch { row.serverDiagnosisUnavailable = true }
          try {
            row.stopWriter = (await localPool.query(`SELECT a.kind,a.fingerprint,a."leaseChanged",
              round(extract(epoch from(a."observedAt"-r."createdAt"))*1000)::int AS "sinceRunMs"
              FROM release_control_audit a JOIN agent_runs r ON r.id=a."runId" WHERE a."runId"=$1 AND r."userId"=$2 ORDER BY a."observedAt" LIMIT 8`, [runId, own.id])).rows
            const factory = (await localPool.query(`SELECT t.status,t.stage,t.reason,a.status AS "attemptStatus",a.reason AS "attemptReason",a.output
              FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2`, [runId, own.id])).rows
            const states = ['pending','running','waiting','blocked','passed','failed','cancelled','revoked','superseded','completed']
            row.factoryBeforeCleanup = factory.map(value => ({ status: states.includes(value.status) ? value.status : 'OTHER',
              stage: ['clarify','spec','execute','review','verify','monitor','close','finished'].includes(value.stage) ? value.stage : 'OTHER',
              attemptStatus: states.includes(value.attemptStatus) ? value.attemptStatus : 'OTHER',
              supersededOwnerRequest: /Superseded by an authenticated owner request/.test(value.attemptReason ?? ''),
              sourceMatches: safeSourceFailures(JSON.stringify(value), signatures) }))
            const events = (await localPool.query(`SELECT id,payload,"createdAt" FROM coordinator_events WHERE "userId"=$1 AND "issueId"=$2 AND kind='user_message' ORDER BY "createdAt",id LIMIT 8`, [own.id, issueId])).rows
            row.ownerEventCount = events.length
            const eventSources = ['host_dispatch','thread_continuation','thread_submission','user','mcp','chat']
            row.ownerEventOrigins = events.map((event, index) => ({ index, source: eventSources.includes(event.payload?.source) ? event.payload.source : 'OTHER',
              hasOriginEvent: UUID.test(event.payload?.originEventId ?? ''), originIsFirst: event.payload?.originEventId === events[0]?.id,
              previousIsThisRun: event.payload?.previousRunId === runId,
              textMatchesFirst: typeof event.payload?.text === 'string' && event.payload.text === events[0]?.payload?.text,
              sinceFirstMs: new Date(event.createdAt).getTime() - new Date(events[0].createdAt).getTime() }))
          } catch { row.stopWriterUnavailable = true }
          try { row.serverLogSourceFailures = safeSourceFailures(await docker(['logs', '--tail', '150', name + '-app']), signatures) } catch { row.serverLogUnavailable = true }
          try {
            const { USER_ERROR_CODES } = await import(pathToFileURL(source + '/packages/protocol/src/user-error-codes.ts'))
            row.failureReceipt = safeThreadFailure(await community.rpc('agents.getIssueThread', [issueId, runId]), USER_ERROR_CODES)
            const frozen = (await community.json('/api/runs/' + runId + '/evidence')).run
            row.frozenModel = ['claude-haiku-5-5','gpt-6-luna'].includes(frozen?.model) ? frozen.model : 'OTHER'
            row.frozenCredentialType = ['subscription','api_key','unknown'].includes(frozen?.credentialType) ? frozen.credentialType : 'OTHER'
          } catch { row.failureReceiptUnavailable = true }
          row.observedExecution = { agentStarted: Boolean(executionRecord?.agentStart), providerChunk: Boolean(executionRecord?.firstProviderChunk), replyAfterTool: Boolean(executionRecord?.replyVerifiedAfterTool) }
        }
      }
      finally {
        if (!deviceId && sandbox) { try { const proof = JSON.parse(await sandbox.files.read('/home/user/.mikka/template-acceptance/device-proof.json', { user: 'root' })); if (UUID.test(proof.deviceId) && proof.harness === s.harness) deviceId = proof.deviceId } catch { /* registration may not have completed */ } }
        if (runId) { try {
          await cleanupCase(community, executionRecord, 'device', { timeoutMs: 45000 })
          row.cleanup.runStopped = executionRecord.cleanup?.status === 'passed'
          row.cleanup.factoryCancelled = executionRecord.cleanup?.factoryCancelled === true
        } catch { row.cleanup.runStopped = false } }
        if (deviceId) { try { await community.rpc('agents.removeDevice', [deviceId]); row.cleanup.deviceRemoved = true } catch { row.cleanup.deviceRemoved = false } }
        if (sandbox) { try { await sandbox.kill(); row.cleanup.vmStopped = true; journal.vms = journal.vms.filter(id => id !== sandbox.sandboxId); await saveJournal() } catch { row.cleanup.vmStopped = false } }
      }
    }
    const threadsPassed = report.cases.length === 2 && report.cases.every(c => c.status === 'passed' && c.cleanup.vmStopped
      && c.cleanup.deviceRemoved && c.cleanup.pullRequestClosed && c.cleanup.branchDeleted)
    report.subscriptionStatus = threadsPassed ? 'passed' : 'incomplete'
    // The original vault owner already completed this exact normal path on a
    // formally released image. Keep its provenance separate; do not allocate
    // another VM or present that external result as a case executed here.
    report.vault = { status: 'not_run', reason: 'separate_actions_evidence',
      applicationSha: '7223cf3a0238863432e9b72be8e47f9889b29efd',
      driverSha: '1d4a4552f49808299b5fc6d43c16f8b0d00351f3',
      runId: '42519451736', jobId: '128849821797', artifactId: '13633021997',
      artifactSha256: '4fffd1dbb4a9069ea2526178d04f8aeaa817091664e9f7228c7d26bb52407206',
      evidenceUrl: 'https://github.com/alexj11324/Mikka/issues/1562#issuecomment-6726676747',
      screenshotProtection: 'pending_original_owner' }
    if (nativeOnly) {
      report.acceptanceScope = ['self_hosted_official_subscription_delivery', 'community_monitoring']
      report.cloudModels = { status: 'not_run', reason: 'separate_scope_previously_evidenced' }
      report.quotaNotice = { status: 'not_run', reason: 'genuine_empty_wallet_and_official_ui_not_available', emptyWalletPassed: false }
      report.liveIdleBudget = { status: 'not_run', reason: 'issue_1561_already_accepted' }
    } else {
    report.acceptanceScope = ['self_hosted_official_subscription_delivery', 'cloud_models_and_decision',
      'owned_server_key_quota_ui', 'live_idle_observation', 'community_monitoring']
    report.stage = 'self-hosted-cloud-models'
    report.cloudModels = { status: 'failed', cleanup: {}, requests: 0 }
    let modelPool, modelWorkspacePool, modelKey, modelContext, modelTeam, quotaTeam, live
    const modelBots = []
    try {
      const binding = await bindCloud(['github', 'models'], workspaces => workspaces.find(w => w.kind === 'team'
        && sources.some(s => s.selectedWorkspace === w.id)))
      modelTeam = binding.workspaceId
      report.cloudModels.workspaceHash = sha(modelTeam).slice(0, 16)
      const model = /^export const COORDINATOR_MODEL = ['"]([^'"]+)['"]/m.exec(await readFile(source + '/lib/coordinator/model.ts', 'utf8'))?.[1]
      check(typeof model === 'string', 'CLOUD_MODEL_SOURCE')
      await execute(process.execPath, [source + '/scripts/assert-test-model.mjs', model])
      report.cloudModels.model = model
      const { socketEvents } = await import(pathToFileURL(source + '/scripts/acceptance/self-hosted-services.mjs'))
      const ticket = await community.json('/api/live/ticket?workspace=' + workspace.id), socket = new URL(ticket.url)
      check(socket.protocol === 'wss:' && socket.origin === origin.replace(/^https:/, 'wss:')
        && socket.pathname.startsWith('/mikka/v1/live/') && typeof ticket.protocol === 'string'
        && ticket.expiresAt > Date.now(), 'CLOUD_MODEL_LIVE')
      live = socketEvents(ticket.url, ticket.protocol)
      await live.ready; await live.next(value => value.type === 'live_ready')
      let quotaBotId
      const chat = async quota => {
        const bot = await community.json('/api/bots', post({ name: 'Cloud model acceptance ' + env.GITHUB_RUN_ID + (quota ? ' quota' : ' reply') }))
        check(UUID.test(bot.id) && bot.workspaceId === workspace.id, 'CLOUD_MODEL_BOT'); modelBots.push(bot.id)
        if (quota) quotaBotId = bot.id
        const selected = await community.json('/api/mobile/model', { ...post({ bot: bot.id, id: '00000000-0000-0000-0000-000000000000' }), method: 'PUT' })
        check(selected.current?.kind === 'hosted' && selected.current.hostedSource === 'cloud', 'CLOUD_MODEL_SELECTION')
        const marker = 'SELFHOSTED_CLOUD_' + randomUUID(), started = Date.now(), deadline = started + 150000
        report.cloudModels.requests++
        await community.json('/api/mobile/chat', post({ botId: bot.id, text: 'Reply exactly ' + marker + '. Do not use tools, create tasks, or contact anyone.', submissionId: randomUUID() }))
        while (Date.now() < deadline) {
          const result = cloudChatResult(await community.json('/api/mobile/chat?bot=' + bot.id), marker, quota)
          if (result) return { ...result, durationMs: Date.now() - started }
          await live.next(value => value.kind === 'bot_chat' && value.id === bot.id, deadline - Date.now())
        }
        throw Error('COMMUNITY_CLOUD_CHAT_DEADLINE')
      }
      report.cloudModels.reply = await chat(false)
      const billing = new URL((await community.json('/api/cloud/models/billing')).url)
      check(billing.origin === PUBLIC && billing.searchParams.get('section') === 'billing'
        && billing.searchParams.get('workspace') === modelTeam, 'CLOUD_MODEL_BILLING')
      report.cloudModels.billingWorkspaceMatches = true
      // A new dedicated zero-limit key exercises real quota admission without
      // changing the shared workspace's balance, card or existing keys.
      modelContext = await cloud.json('/cloud/v1/management/context')
      const adminTeams = (modelContext.workspaces ?? []).filter(w => w.kind === 'team' && w.role === 'admin' && UUID.test(w.id))
      quotaTeam = (adminTeams.find(w => w.id === modelTeam) ?? adminTeams[0])?.id
      check(UUID.test(quotaTeam ?? ''), 'CLOUD_MODEL_ADMIN_WORKSPACE')
      report.cloudModels.quotaBoundary = { kind: 'owned_server_key_monthly_limit', monthlyLimitMicroUsd: 0,
        workspaceHash: sha(quotaTeam).slice(0,16), sameWorkspaceAsDefault: quotaTeam === modelTeam, actorRole: 'admin' }
      const created = await cloud.request('/cloud/v1/management/keys', { ...post({ serverId: binding.serverId,
        workspaceId: quotaTeam, name: 'Self-hosted quota acceptance ' + env.GITHUB_RUN_ID, scopes: ['models'], monthlyLimitMicroUsd: 0 }),
        headers: { 'content-type': 'application/json', 'x-csrf-token': modelContext.csrfToken } })
      check(created.status === 201, 'CLOUD_MODEL_KEY')
      const key = await created.json(); check(UUID.test(key.keyId) && typeof key.serverKey === 'string', 'CLOUD_MODEL_KEY_SCHEMA')
      modelKey = key.keyId
      await community.json('/api/cloud/connect', post({ action: 'key', key: key.serverKey }))
      await community.json('/api/cloud/disconnect', post({ action: 'personal' }))
      report.cloudModels.quota = await chat(true)
      const topUp = new URL((await community.json('/api/cloud/models/billing')).url)
      check(topUp.origin === PUBLIC && topUp.searchParams.get('workspace') === quotaTeam
        && topUp.searchParams.get('section') === 'billing', 'CLOUD_MODEL_QUOTA_BILLING')
      report.cloudModels.quota.billingAvailableAtZeroLimit = true
      check(report.cloudModels.quota.status === 'passed', 'CLOUD_MODEL_QUOTA')
      report.cloudModels.quota.ui = await captureQuotaNotice({ chromium: requireSource('@playwright/test').chromium,
        origin, botId: quotaBotId, email, password, source, revision })
      check(report.cloudModels.quota.ui.status === 'passed', 'CLOUD_MODEL_QUOTA_UI')
      report.liveIdleBudget = report.cloudModels.quota.ui.liveIdleBudget
      // cloud.model_calls and hosted_usage live in the primary application DB;
      // the Marketplace DATABASE_URL contains membership/workspace metadata.
      modelPool = new Pool({ connectionString: database, max: 1, ssl: { rejectUnauthorized: true }, options: '-c default_transaction_read_only=on' })
      await modelPool.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const rows = (await modelPool.query(`SELECT c.model,c.workspace_id=$2 AS "workspaceMatches",
        c.payer_workspace_id::text AS "payerWorkspace",c.payer_workspace_id=u."workspaceId" AS "ledgerPayerMatches",
        c.model=u.model AS "usageModelMatches",c.credential_kind AS "credentialKind",u.state,
        u."inputTokens",u."outputTokens",u."costMicroUsd",c.completed_at IS NOT NULL AS completed
        FROM cloud.model_calls c LEFT JOIN public.hosted_usage u ON u.id=c.usage_id
        WHERE c.server_id=$1 ORDER BY c.created_at LIMIT 13`, [binding.serverId, modelTeam])).rows
      const payerIds = [...new Set(rows.map(row => row.payerWorkspace).filter(id => UUID.test(id ?? '') && id !== modelTeam))]
      const sharedPayers = new Map()
      if (payerIds.length) {
        const shares = (await modelPool.query('SELECT "userId" FROM workspace_credit_shares WHERE "workspaceId"=$1 ORDER BY "sharedAt","userId" LIMIT 101', [modelTeam])).rows
        check(shares.length <= 100, 'CLOUD_MODEL_SHARE_BOUNDS')
        modelWorkspacePool = new Pool({ connectionString: await secret('/neon','DATABASE_URL'), max: 1,
          ssl: { rejectUnauthorized: true }, options: '-c default_transaction_read_only=on' })
        await modelWorkspacePool.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const allowed = (await modelWorkspacePool.query(`SELECT p.id::text AS id,p."userId"=ANY($3::text[]) AS opted,
          EXISTS(SELECT 1 FROM mikka_workspace_members m JOIN mikka_workspaces t ON t.id=m."workspaceId" AND t.kind='team'
            WHERE m."workspaceId"=$1 AND m."userId"=p."userId" AND m.status='active') AS active,
          (SELECT count(*) FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active')=1
            AND NOT EXISTS(SELECT 1 FROM mikka_workspace_invitations WHERE "workspaceId"=$1 AND status='pending' AND "expiresAt">now()) AS solo
          FROM mikka_workspaces p WHERE p.id=ANY($2::uuid[]) AND p.kind='personal'`, [modelTeam,payerIds,shares.map(row=>row.userId)])).rows
        for (const row of allowed) if (row.active && (row.opted || row.solo)) sharedPayers.set(row.id,row.opted ? 'shared_credit' : 'solo_credit')
        await modelWorkspacePool.query('ROLLBACK')
      }
      report.cloudModels.billing = cloudModelBillingReceipt(rows,model,modelTeam,sharedPayers)
      report.cloudModels.tokenCounterSource = 'public_ledger_recorded_values'
      await modelPool.query('ROLLBACK')
      check(report.cloudModels.reply.status === 'passed' && report.cloudModels.quota.status === 'passed', 'CLOUD_MODEL_CASES')
      report.cloudModels.status = 'passed'
    } catch (error) {
      report.cloudModels.code = /^COMMUNITY_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_CLOUD_MODEL_FAILED'
    } finally {
      await modelPool?.end(); await modelWorkspacePool?.end()
      if (live) { live.close(); await Promise.race([live.closed, new Promise(resolve => setTimeout(resolve, 5000))]) }
      for (const id of modelBots) { try {
        await community.rpc('coordinator.stopCoordinatorTurn', [id])
      } catch { report.cloudModels.cleanup.turnsStopped = false } }
      if (modelBots.length && report.cloudModels.cleanup.turnsStopped !== false) report.cloudModels.cleanup.turnsStopped = true
      report.cloudModels.cleanup.dataLifetime = 'owned_disposable_compose_volume'
      if (modelKey) { try {
        const revoked = await cloud.request('/cloud/v1/management/revoke', { ...post({ workspaceId: quotaTeam, kind: 'key', id: modelKey }),
          headers: { 'content-type': 'application/json', 'x-csrf-token': modelContext.csrfToken } })
        check(revoked.ok, 'CLOUD_MODEL_KEY_CLEANUP'); await revoked.body?.cancel(); report.cloudModels.cleanup.keyRevoked = true
      } catch { report.cloudModels.cleanup.keyRevoked = false } }
      if (Object.values(report.cloudModels.cleanup).some(value => value === false)) report.cloudModels.status = 'failed'
    }
    }
    report.publicFinalBuild = (await cloud.json('/api/version')).build
    check(/^[a-f0-9]{40}$/.test(report.publicFinalBuild), 'PUBLIC_VERSION')
    // The tested self-hosted container and each VM's verified worker files
    // stay fixed. A separately deployed shared management page or new default
    // does not replace those machines. Preserve both observations honestly.
    if (!nativeOnly) check(sharedBuilds.includes(report.publicFinalBuild), 'PUBLIC_CHANGED')
    report.sharedWorkerAtEnd = (await readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN })).workerSha
    if (!nativeOnly) check(report.sharedWorkerAtEnd === report.sharedWorkerAtStart, 'WORKER_CHANGED')
    report.sharedServiceObservations = { publicBuildChanged: report.publicFinalBuild !== report.publicBuild,
      defaultWorkerChanged: report.sharedWorkerAtEnd !== report.sharedWorkerAtStart,
      selfHostedImageFixed: Boolean(report.imageRuntime),
      eachNativeVmWorkerVerified: report.cases.length === 2 && report.cases.every(row => row.vmWorkerVerified === true),
      sharedApplicationSourceEquivalenceClaimed: false }
    report.privateCloudAtEnd = await privateRelease()
    check(report.privateCloudAtEnd.id === report.privateCloudAtStart.id, 'PRIVATE_DEPLOYMENT_CHANGED')
    report.status = threadsPassed && report.communityMonitoring?.status === 'passed'
      && (nativeOnly || report.cloudModels.status === 'passed' && report.liveIdleBudget?.status === 'passed') ? 'passed' : 'partial'
  } catch (error) { report.code = /^COMMUNITY_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_FAILED'; report.causeCode = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.cause?.code) ? error.cause.code : 'OTHER' }
  finally {
    if (serverRegistered) { try { await community.json('/api/cloud/disconnect', post({ action: 'server' })); report.cleanup.cloudServerRevoked = true } catch { report.cleanup.cloudServerRevoked = false } }
    if (cloud && originalCloudWorkspace) { try {
      await restoreAcceptanceWorkspace(cloud, originalCloudOwner, originalCloudWorkspace); report.cleanup.cloudWorkspaceRestored = true
    } catch { report.cleanup.cloudWorkspaceRestored = false } }
    for (const client of sessions.reverse()) { try { await client.json('/api/auth/sign-out', post({})); report.cleanup.sessionsClosed = (report.cleanup.sessionsClosed ?? true) && true } catch { report.cleanup.sessionsClosed = false } }
    await privatePool?.end(); await localPool?.end()
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) { const exited = once(tunnel, 'exit'); tunnel.kill('SIGTERM'); await exited.catch(() => {}) }
    for (const [kind, target] of resources.filter(([k]) => k === 'container').reverse()) { try { await docker(['rm', '-f', '-v', target]) } catch { report.cleanup.docker = false } }
    for (const [kind, target] of resources.filter(([k]) => k !== 'container').reverse()) { try { await docker([kind, 'rm', target]) } catch { report.cleanup.docker = false } }
    for (const name of createdSecrets) { try { await inf('/api/v4/secrets/' + name, 'DELETE', { projectId: PROJECT, environment: 'dev', secretPath: devPath, type: 'shared' }) } catch { report.cleanup.accessSecretsRemoved = false } }
    if (ownFolder) { try { await inf('/api/v2/folders/' + ownFolder, 'DELETE', { projectId: PROJECT, environment: 'dev' }); report.cleanup.ownFolderRemoved = true } catch { report.cleanup.ownFolderRemoved = false } }
    if (Object.values(report.cleanup).some(v => v === false)) report.status = 'failed'
    await mkdir('.artifacts/self-hosting', { recursive: true })
    await writeFile('.artifacts/self-hosting/community-subscriptions.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv[2] === '--cleanup') await cleanupCommunity(); else if ((await runCommunity()).status !== 'passed') process.exitCode = 1 }
  catch { console.log(JSON.stringify({ status: 'failed', code: 'COMMUNITY_GUARD' })); process.exitCode = 1 }
}

// Release checkpoint: Apple status is read-only, separate from device acceptance.

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// PR comments use explicit Pull requests write; Apple/EAS readbacks run independently of protocol completion.

// Apple readback JWT scope includes the exact fixed build filters and sparse fields; no native redispatch.

// Community release pin contains native-auth fix1668; production writers must complete before activation.

// Published artifact and actual served control-plane build identify this run; unserved Git HEAD is metadata only.

// Formal-source pin follows the verified no-credential final-controller preflight.

// Final-source checkpoint after the shared-team selector stage.
