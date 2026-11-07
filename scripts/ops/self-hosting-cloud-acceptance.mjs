import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
// The separate community driver proves full native threads; this receiver
// remains a protocol/webhook proof and never claims community task completion.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'

const PUBLIC = 'https://app.aspectlylabs.com'
const PRIVATE = 'https://mikka-cloud.vercel.app'
const PREFIX = '/mikka/cloud'
const check = (value, code) => { if (!value) throw Error(code) }
const sha = value => createHash('sha256').update(value).digest('base64url')
const CODES = new Set(['SMOKE_ACCOUNT_REQUIRED', 'TUNNEL_START', 'TUNNEL_HTTP', 'REGISTRATION', 'IDENTITY', 'CONTEXT', 'CONSENT', 'CALLBACK', 'TOKEN', 'PERSONAL_SCOPE', 'REFRESH', 'REVOKE', 'TEAM_ADMIN', 'TEAM_KEY', 'TEAM_SCOPE', 'GITHUB_INSTALLATION', 'GITHUB_SETUP', 'GITHUB_TOKEN', 'GITHUB_READ', 'GITHUB_RENEW', 'GITHUB_REVOKE', 'WEBHOOK_TIMEOUT', 'WEBHOOK_EVENT', 'HTTP_TRANSPORT', 'HTTP_SCHEMA', 'LOGIN', 'VERSION', 'CLEANUP'])
export const acceptanceCode = error => CODES.has(error?.message) ? error.message : 'ACCEPTANCE_FAILED'
export function smokeAccount(env) {
  check(typeof env.SMOKE_OWNER_EMAIL === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(env.SMOKE_OWNER_EMAIL) && env.SMOKE_OWNER_PASSWORD, 'SMOKE_ACCOUNT_REQUIRED')
}
export function verifyDelivery(body, signature, secret, now = Date.now()) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature ?? '')
  return Boolean(match && Math.abs(now / 1000 - Number(match[1])) < 300 && createHmac('sha256', secret).update(`${match[1]}.${body}`).digest('hex') === match[2])
}

/** Real production OAuth/GitHub protocol acceptance. The controlled HTTPS
 * receiver proves callbacks and signed webhook delivery; it is not described
 * as a complete self-hosted Mikka installation or subscription-thread proof. */
export async function businessAcceptance({ env = process.env, fetcher = fetch, report }) {
  smokeAccount(env)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/ops/infisical-cloud-capabilities', 'IDENTITY')
  let cookie = '', registration, tunnel, receiver, closed = false, resolveDelivery
  const deliveries = []
  report.checks = {}; report.cleanup = {}; report.businessAcceptanceComplete = false
  report.applicationSecretValuesRequested = true; report.secretValuesRemainInRunner = true
  const deployment = async () => {
    const response = await fetcher('https://api.vercel.com/v9/projects/prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc?teamId=team_C7lwxVVvnUicFli6112mvxpv', { headers: { authorization: 'Bearer ' + env.VERCEL_TEAM_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    check(response.ok, 'VERSION'); const project = await response.json(), deployed = project.targets?.production
    check(project.id === 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc' && deployed?.readyState === 'READY' && /^[a-f0-9]{40}$/.test(deployed.meta?.githubCommitSha ?? ''), 'VERSION')
    return { id: deployed.id, source: deployed.meta.githubCommitSha }
  }
  const cloudOrigin = env.MIKKA_CLOUD_ACCEPTANCE_PUBLIC === '1' ? PUBLIC : PRIVATE
  report.cloudRoute = cloudOrigin === PUBLIC ? 'public_bridge' : 'private_backend'
  const request = async (operation, origin, path, { method = 'GET', body, bearer, csrf, form, github = false } = {}) => {
    check([PUBLIC, PRIVATE, 'https://api.github.com'].includes(origin), 'IDENTITY')
    let response
    try { response = await fetcher(origin + path, { method, redirect: 'manual', signal: AbortSignal.timeout(operation === 'hosted_metering_call' ? 90000 : 30000), headers: {
      origin: PUBLIC, ...(origin === PUBLIC || origin === PRIVATE ? cookie ? { cookie } : {} : {}),
      ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(github ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } : {}),
    }, ...(body ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}) }) } catch { throw Error('HTTP_TRANSPORT') }
    report.http.push({ operation, status: response.status })
    if (operation === 'github_webhook_progress_comment' && !response.ok) {
      let body; try { body = await response.clone().json() } catch { body = {} }
      const message = String(body.message ?? '')
      const accepted = response.headers.get('x-accepted-github-permissions') ?? ''
      report.githubCommentDenial = { status: response.status,
        reason: /resource not accessible by integration/i.test(message) ? 'resource_not_accessible_by_integration' : /rate limit|abuse|spam/i.test(message) ? 'rate_limited' : /permission|forbidden/i.test(message) ? 'permission_denied' : 'other',
        acceptedPermissions: /^[a-zA-Z0-9_:,;= -]{0,500}$/.test(accepted) ? accepted : 'OTHER' }
    }
    return response
  }
  const json = async (operation, path, options, status = 200) => {
    const response = await request(operation, cloudOrigin, PREFIX + path, options)
    check(response.status === status, operation.startsWith('github') ? 'GITHUB_TOKEN' : 'HTTP_SCHEMA'); return response.json()
  }
  const form = (operation, path, body) => json(operation, path, { method: 'POST', body, form: true })
  const meter = async (billingToken, billingWorkspaceId) => {
    const hostedModel = 'deepseek/deepseek-v4.1-flash'
    execFileSync(process.execPath, ['scripts/assert-test-model.mjs', hostedModel], { stdio: 'pipe' })
    const completion = await request('hosted_metering_call', cloudOrigin, PREFIX + '/v1/models/chat/completions', { method: 'POST', bearer: billingToken.access_token, body: { model: hostedModel, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false } })
    const result = await completion.json()
    report.metering = { status: completion.status, serverId: registration.serverId, authorizationWorkspaceHash: createHash('sha256').update(billingWorkspaceId).digest('hex').slice(0, 16), model: hostedModel, attempts: 1, trialAllowed: false }
    if (completion.ok) {
      check(result.model === hostedModel && Number.isSafeInteger(result.usage?.total_tokens) && result.usage.total_tokens > 0, 'HTTP_SCHEMA')
      report.metering.completionReturned = true; report.metering.usage = { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens, totalTokens: result.usage.total_tokens }; report.metering.ledgerVerification = 'pending_read_only_receipt'
    } else {
      report.metering.code = ['cloud_quota_exhausted', 'cloud_unavailable', 'cloud_access_denied', 'cloud_rate_limited'].includes(result.code) ? result.code : 'OTHER'
      report.metering.completionReturned = false
    }
  }
  try {
    report.privateDeployment = await deployment()
    const login = await request('business_login', PUBLIC, '/mikka/api/auth/sign-in/email', { method: 'POST', body: { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD } })
    check(login.ok, 'LOGIN'); cookie = login.headers.getSetCookie().map(s => s.split(';', 1)[0]).join('; '); await login.body?.cancel()
    const identity = await (await request('business_identity', PUBLIC, '/mikka/api/auth/get-session?disableCookieCache=true')).json()
    check(identity.user?.email?.toLowerCase() === env.SMOKE_OWNER_EMAIL.toLowerCase(), 'IDENTITY')
    const version = await (await request('business_version', PUBLIC, '/mikka/api/version')).json(); check(/^[a-f0-9]{40}$/.test(version.build ?? ''), 'VERSION'); report.publicVersion = version.build
    const context = await json('business_context', '/v1/management/context')
    check(typeof context.csrfToken === 'string' && Array.isArray(context.workspaces), 'CONTEXT')
    const personal = context.workspaces.find(w => w.kind === 'personal'), team = context.workspaces.find(w => w.kind === 'team' && w.role === 'admin')
    check(personal && team, 'TEAM_ADMIN')

    receiver = createServer(async (req, res) => {
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) { res.writeHead(413).end(); return }; chunks.push(chunk) }
        if (req.method === 'POST' && req.url === '/mikka/api/cloud/webhooks/github' && registration) {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!verifyDelivery(body, req.headers['mikka-cloud-signature'], registration.serverSecret)) { res.writeHead(401).end(); return }
          const value = JSON.parse(body)
          deliveries.push({ event: req.headers['x-github-event'], commentId: value.comment?.id, deliveryId: req.headers['x-github-delivery'] })
          resolveDelivery?.(); res.writeHead(202).end(); return
        }
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Mikka release acceptance receiver')
      } catch { res.writeHead(400).end() }
    })
    receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
    tunnel = spawn(env.RUNNER_TEMP + '/mikka-cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + receiver.address().port, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: env.PATH, HOME: env.RUNNER_TEMP } })
    const origin = await new Promise((resolve, reject) => {
      let buffer = ''; const timer = setTimeout(() => reject(Error('TUNNEL_START')), 45000)
      const observe = chunk => { buffer = (buffer + chunk.toString()).slice(-64000); const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buffer); if (match && buffer.includes('Registered tunnel connection')) { clearTimeout(timer); resolve(match[0]) } }
      tunnel.stdout.on('data', observe); tunnel.stderr.on('data', observe); tunnel.on('error', () => { clearTimeout(timer); reject(Error('TUNNEL_START')) }); tunnel.on('exit', () => { if (!closed) { clearTimeout(timer); reject(Error('TUNNEL_START')) } })
    })
    report.receiverOrigin = origin; report.receiverReadiness = []
    let reachable = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const publicReceiver = await fetcher(origin, { redirect: 'error', signal: AbortSignal.timeout(10000) })
        report.receiverReadiness.push({ status: publicReceiver.status })
        reachable = publicReceiver.ok && (await publicReceiver.text()) === 'Mikka release acceptance receiver'
      } catch (error) {
        const codes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
        report.receiverReadiness.push({ cause: codes.includes(error?.cause?.code) ? error.cause.code : 'OTHER' })
      }
      if (reachable) break
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000))
    }
    check(reachable, 'TUNNEL_HTTP')
    report.checks.receiverReachableBeforeRegistration = true
    // The normal dynamic registration validates public HTTPS and resolves DNS.
    registration = await json('server_register', '/v1/servers/register', { method: 'POST', body: { origin, basePath: '/mikka', name: 'Mikka release acceptance ' + env.GITHUB_RUN_ID } }, 201)
    check(registration.redirectUri === origin + '/mikka/api/cloud/callback' && typeof registration.serverSecret === 'string', 'REGISTRATION')
    report.checks.publicHttpsRegistration = true
    const credentials = { client_id: registration.serverId, client_secret: registration.serverSecret }
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id: registration.serverId, redirect_uri: registration.redirectUri, scope: env.MIKKA_METERING_ONLY === '1' ? 'models' : 'github push models', state, code_challenge: sha(verifier), code_challenge_method: 'S256' })
    const consent = await request('personal_consent', cloudOrigin, PREFIX + '/oauth/authorize?' + query)
    check(consent.ok, 'CONSENT'); const html = await consent.text()
    const boot = /<script[^>]*id="cloud-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html)
    check(boot, 'CONSENT'); const model = JSON.parse(boot[1]).model
    check(model?.workspaces?.some(w => w.id === personal.id) && model.csrfToken && model.requestId, 'CONSENT')
    const approved = await request('personal_approve', cloudOrigin, PREFIX + '/oauth/authorize', { method: 'POST', form: true, body: { request_id: model.requestId, csrf_token: model.csrfToken, workspace_id: personal.id, approve: 'true' } })
    check(approved.status === 302, 'CALLBACK'); const callback = new URL(approved.headers.get('location'))
    check(callback.origin === origin && callback.pathname === '/mikka/api/cloud/callback' && callback.searchParams.get('state') === state && callback.searchParams.has('code'), 'CALLBACK')
    let token = await form('personal_exchange', '/oauth/token', { ...credentials, grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: registration.redirectUri })
    const me = await json('personal_me', '/v1/me', { bearer: token.access_token }); check(me.serverId === registration.serverId && me.workspaceId === personal.id && me.grantType === 'user', 'PERSONAL_SCOPE')
    report.checks.personalPkce = true
    if (env.MIKKA_METERING_ONLY === '1') {
      // The prior read-only receipt proved this existing personal workspace
      // has paid eligibility. The provider is called once, with normal consent.
      check(createHash('sha256').update(personal.id).digest('hex').slice(0, 16) === '683a9e11b0c2d41f', 'PERSONAL_SCOPE')
      await meter(token, personal.id)
      report.result = report.metering.completionReturned ? 'metering_request_completed' : 'metering_request_denied'
      return
    }
    const next = await form('personal_refresh', '/oauth/token', { ...credentials, grant_type: 'refresh_token', refresh_token: token.refresh_token })
    check(next.refresh_token && next.refresh_token !== token.refresh_token && next.workspace_id === personal.id, 'REFRESH'); token = next; report.checks.personalRefresh = true

    // Team actions use this same real account's administrator workspace only.
    const key = await json('team_key_create', '/v1/management/keys', { method: 'POST', csrf: context.csrfToken, body: { serverId: registration.serverId, workspaceId: team.id, name: 'Release acceptance ' + env.GITHUB_RUN_ID, scopes: ['models'], monthlyLimitMicroUsd: 0 } }, 201)
    check(key.keyId && key.serverKey, 'TEAM_KEY')
    const teamToken = await form('team_key_exchange', '/oauth/token', { client_id: registration.serverId, client_secret: key.serverKey, grant_type: 'client_credentials' })
    const teamMe = await json('team_key_me', '/v1/me', { bearer: teamToken.access_token }); check(teamMe.workspaceId === team.id && teamMe.grantType === 'server_key' && !teamToken.refresh_token, 'TEAM_SCOPE')
    await json('team_key_revoke', '/v1/management/revoke', { method: 'POST', csrf: context.csrfToken, body: { workspaceId: team.id, kind: 'key', id: key.keyId } })
    const teamDenied = await request('team_key_revoked_me', cloudOrigin, PREFIX + '/v1/me', { bearer: teamToken.access_token }); check(teamDenied.status === 401 || teamDenied.status === 403, 'REVOKE'); await teamDenied.body?.cancel(); report.checks.teamKeyAndRevocation = true

    // Existing shared account connection supplies an actual installation ID;
    // no invented installation/user identities, provider token or App secret.
    const github = await (await request('github_connection', PUBLIC, '/mikka/api/integrations/github')).json()
    const repository = github.repositories?.find(r => r.fullName === 'alexj11324/Mikka')
    check(repository?.installationId && github.connected && github.installed, 'GITHUB_INSTALLATION')
    const intent = await json('github_prepare', '/v1/github/install', { method: 'POST', body: {}, bearer: token.access_token })
    const install = new URL(intent.url); check(install.origin === 'https://github.com' && install.pathname === '/apps/mikka-github/installations/new', 'GITHUB_SETUP')
    const setup = await request('github_setup', cloudOrigin, PREFIX + '/v1/github/setup?' + new URLSearchParams({ state: install.searchParams.get('state'), installation_id: repository.installationId }))
    check(setup.status === 302 && new URL(setup.headers.get('location')).origin === origin, 'GITHUB_SETUP'); await setup.body?.cancel(); report.checks.githubPreparation = true
    const native = await json('github_native_token', '/v1/github/installation-token', { method: 'POST', bearer: token.access_token, body: { installationId: repository.installationId, repositories: ['Mikka'], permissions: { contents: 'read', metadata: 'read' } } })
    const read = await request('github_native_read', 'https://api.github.com', '/repos/alexj11324/Mikka', { bearer: native.token, github: true }); check(read.ok, 'GITHUB_READ'); await read.body?.cancel()
    const renewed = await json('github_native_renew', '/v1/github/installation-token', { method: 'POST', bearer: token.access_token, body: { installationId: repository.installationId, repositories: ['Mikka'], permissions: { contents: 'read', metadata: 'read' } } })
    check(renewed.token && renewed.expiresAt && Date.parse(renewed.expiresAt) > Date.now(), 'GITHUB_RENEW'); report.checks.githubNativeReadAndRenewal = true

    if (cloudOrigin === PUBLIC) {
      const comment = await request('github_webhook_progress_comment', 'https://api.github.com', '/repos/alexj11324/Mikka/issues/1591/comments', { method: 'POST', github: true, bearer: env.GITHUB_TOKEN, body: { body: '生产验收进度：正在用共享测试账号验证真实 GitHub webhook → 私有云 outbox → 临时受控 HTTPS 接收端。此评论是本次真实事件，不含凭证；完整业务验收仍在进行。Actions ' + env.GITHUB_RUN_ID } })
      check(comment.status === 201, 'WEBHOOK_EVENT'); const commentId = (await comment.json()).id
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('WEBHOOK_TIMEOUT')), 120000); resolveDelivery = () => { if (deliveries.some(d => d.event === 'issue_comment' && d.commentId === commentId)) { clearTimeout(timer); resolve() } }; resolveDelivery() })
      report.checks.realGitHubWebhook = true
    }
    await form('personal_revoke', '/oauth/revoke', { ...credentials, token: token.refresh_token, token_type_hint: 'refresh_token' })
    const denied = await request('personal_revoked_me', cloudOrigin, PREFIX + '/v1/me', { bearer: token.access_token }); check(denied.status === 401 || denied.status === 403, 'REVOKE'); await denied.body?.cancel(); report.checks.personalRevocation = true
    // Revocation is durable background disposal. Read GitHub's own authority,
    // never treat a Mikka JWT refusal as proof that the native token is gone.
    let invalid = false
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await request('github_native_revocation_readback', 'https://api.github.com', '/installation/repositories', { bearer: renewed.token, github: true }); invalid = result.status === 401; await result.body?.cancel(); if (invalid) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    check(invalid, 'GITHUB_REVOKE'); report.checks.githubNativeRevocation = true

    report.result = 'cloud_protocol_verified'
  } catch (error) {
    report.failure = acceptanceCode(error); throw error
  } finally {
    if (registration) { try { await form('own_server_cleanup', '/v1/servers/revoke', { client_id: registration.serverId, client_secret: registration.serverSecret }); report.cleanup.ownServerRevoked = true } catch { report.cleanup.ownServerRevoked = false } }
    if (cookie) { try { const out = await request('business_logout', PUBLIC, '/mikka/api/auth/sign-out', { method: 'POST', body: {} }); report.cleanup.ownSessionSignedOut = out.ok; await out.body?.cancel() } catch { report.cleanup.ownSessionSignedOut = false } }
    closed = true; tunnel?.kill('SIGTERM'); receiver?.closeAllConnections(); receiver?.close()
    try {
      const current = await deployment()
      report.cleanup.privateSourceUnchanged = JSON.stringify(current) === JSON.stringify(report.privateDeployment)
      const currentPublic = await (await request('business_final_version', PUBLIC, '/mikka/api/version')).json()
      report.cleanup.publicSourceUnchanged = currentPublic.build === report.publicVersion
    } catch { report.cleanup.sourcesVerified = false }
    if (!report.failure) check(report.cleanup.ownServerRevoked && report.cleanup.ownSessionSignedOut && report.cleanup.privateSourceUnchanged && report.cleanup.publicSourceUnchanged, 'CLEANUP')
  }
}

// Full community setup inspects ordinary protocol redirects rather than following them.

// Staging checkpoint: access-only fixture constraints and owned volume cleanup verified.

// Prepared release checkpoint: independent providers and existing iOS build readback.

// Release checkpoint: Apple status is read-only, separate from device acceptance.

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// Apple readback JWT scope includes the exact fixed build filters and sparse fields; no native redispatch.

// Community release pin contains native-auth fix1668; production writers must complete before activation.

// Source access follows live production project/identity configuration; no new credentials or roles.

// Secret environment values are read from their existing Infisical sync source, never Vercel write-only values.

// Model list materializes virtual IDs before removal; failure receipts exclude provider text.

// Published artifact and actual served control-plane build identify this run; unserved Git HEAD is metadata only.
