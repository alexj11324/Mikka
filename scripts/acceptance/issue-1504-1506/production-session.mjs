import { mkdirSync, writeFileSync } from 'node:fs'
// Temporary acceptance client. Credentials and session cookies remain in memory.
const ORIGIN = 'https://app.aspectlylabs.com'
const BASE = ORIGIN + '/mikka'
export function decode(value) {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    if (value.$mikka === 'undefined') return undefined
    if (value.$mikka === 'date') return value.value
    if (value.$mikka === 'object') return Object.fromEntries(value.value.map(([key, entry]) => [key, decode(entry)]))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]))
  }
  return value
}
export async function productionSession(work) {
  const email = process.env.SMOKE_OWNER_EMAIL
  const password = process.env.SMOKE_OWNER_PASSWORD
  if (!/^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(email ?? '') || !password) throw new Error('smoke_credentials_missing')
  const cookies = new Map()
  const requests = []
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', signal, headers: extra = {} } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('invalid_acceptance_path')
    const url = new URL(BASE + path)
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/mikka/')) throw new Error('invalid_acceptance_origin')
    const started = performance.now()
    const response = await fetch(url, {
      method, redirect: 'error', signal: signal ?? AbortSignal.timeout(180_000),
      headers: { origin: ORIGIN, 'cache-control': 'no-store',
        ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]
      const at = pair.indexOf('=')
      if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    requests.push({ path: url.pathname, method, status: response.status, headersMs: Math.round(performance.now() - started), requestId: response.headers.get('x-vercel-id') })
    return response
  }
  async function json(path, body, method) {
    const response = await request(path, { body, method })
    const value = await response.json().catch(() => null)
    if (!response.ok || value?.error) {
      const code = typeof value?.error === 'string' ? value.error : value?.error?.code
      const error = new Error('acceptance_http_failed')
      error.details = { path: path.split('?')[0], status: response.status, code }
      throw error
    }
    return value
  }
  async function rpc(action, args = []) {
    const response = await request('/api/rpc', { body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' } })
    const envelope = await response.json()
    const value = decode(envelope.result)
    if (!response.ok || !envelope.ok || value?.error) {
      const error = new Error('acceptance_rpc_failed')
      error.details = { action, status: response.status, code: envelope.error?.code ?? value?.error }
      throw error
    }
    return value
  }
  try {
    await json('/api/auth/sign-in/email', { email, password })
    const identity = await json('/api/auth/get-session')
    if (identity?.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('acceptance_identity_mismatch')
    const version = await json('/api/version')
    if (process.env.MIKKA_ACCEPTANCE_SHA && version.build !== process.env.MIKKA_ACCEPTANCE_SHA) throw new Error('acceptance_version_mismatch')
    return await work({ request, json, rpc, requests, identity: { userId: identity.user.id }, version })
  } finally {
    if (cookies.size) await json('/api/auth/sign-out', {}).catch(() => {})
    cookies.clear()
  }
}
const KNOWN_MODELS = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'deepseek-flash'])
const enumValue = (value, values) => values.includes(value) ? value : 'unknown'
const publicModel = value => KNOWN_MODELS.has(value) ? value : 'unknown'
const publicSha = value => /^[0-9a-f]{40}$/.test(value ?? '') ? value : null
const publicEntry = entry => ({ harness: enumValue(entry.harness, ['claude_code', 'codex']), model: publicModel(entry.model),
  kind: enumValue(entry.source?.kind, ['subscription', 'api_key']), blocked: Boolean(entry.block) })
const ERROR_CODES = new Set(['smoke_credentials_missing', 'invalid_acceptance_path', 'invalid_acceptance_origin',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'acceptance_identity_mismatch', 'acceptance_version_mismatch',
  'acceptance_version_changed', 'acceptance_version_invalid', 'acceptance_signout_failed'])

export async function runPreflight() {
  const report = { schemaVersion: 1, issues: [1504, 1506], phase: 'preflight', status: 'failed',
    origin: ORIGIN, driverSha: publicSha(process.env.GITHUB_SHA),
    githubRunId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null,
    startedAt: new Date().toISOString(), taskCreation: 0, modelRequests: 0, applicationMutations: 0 }
  let requests = []
  try {
    const metadata = await productionSession(async session => {
      const { json, rpc, version } = session
      requests = session.requests
      if (!publicSha(version.build)) throw new Error('acceptance_version_invalid')
      report.applicationSha = version.build
      const [workspace, bots, order, menu, chat] = await Promise.all([
        json('/api/workspace'), json('/api/bots'), rpc('model-order.getModelOrder'),
        rpc('execution-settings.getBotModelMenu', [null]), json('/api/coordinator/messages'),
      ])
      const endingVersion = await json('/api/version')
      if (endingVersion.build !== version.build) throw new Error('acceptance_version_changed')
      return {
        identityVerified: true, applicationVersionStable: true,
        workspacePresent: Boolean(workspace.workspace?.id || workspace.currentWorkspaceId),
        bots: { count: Array.isArray(bots) ? bots.length : 0, smokeBotPresent: Array.isArray(bots) && bots.some(bot => bot.name === 'Smoke Bot') },
        order: { autoModelRouting: order.autoModelRouting === true, cloudReady: order.cloudReady === true,
          preferredHarness: enumValue(order.preferredHarness, ['claude_code', 'codex']),
          entries: Array.isArray(order.entries) ? order.entries.map(publicEntry) : [],
          candidates: Array.isArray(order.candidates) ? order.candidates.map(publicEntry) : [] },
        menu: { currentModel: publicModel(menu.current?.modelId), available: menu.current?.available === true,
          groupCount: Array.isArray(menu.groups) ? menu.groups.length : 0 },
        chat: { botPresent: Boolean(chat.botId), enabled: chat.enabled === true, working: chat.working === true, activeStream: Boolean(chat.streamRunId) },
      }
    })
    Object.assign(report, metadata)
    const signout = requests.findLast(request => request.path === '/mikka/api/auth/sign-out')
    if (!signout || signout.status < 200 || signout.status >= 300) throw new Error('acceptance_signout_failed')
    report.signedOut = true
    report.status = 'passed'
  } catch (error) {
    report.error = ERROR_CODES.has(error?.message) ? error.message : 'acceptance_unexpected_failure'
    if (Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599) report.httpStatus = error.details.status
  }
  // Fixed route names, status codes and durations only. Never cookies, response bodies or source IDs.
  report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
  report.finishedAt = new Date().toISOString()
  return report
}

if (process.argv[2] === 'preflight') {
  const report = await runPreflight()
  mkdirSync('issue-1504-1506-report', { recursive: true })
  writeFileSync('issue-1504-1506-report/preflight.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
