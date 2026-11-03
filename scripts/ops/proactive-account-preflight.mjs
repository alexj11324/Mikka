import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
const email = process.env.MIKKA_TEST_ACCOUNT_EMAIL ?? process.env.SMOKE_OWNER_EMAIL
const password = process.env.MIKKA_TEST_ACCOUNT_PASSWORD ?? process.env.SMOKE_OWNER_PASSWORD
const report = { status: 'running', account: email === 'alexjiang20232024@gmail.com' ? 'authorized-main' : 'existing-smoke' }
report.testFlashKeyConfigured = Boolean(process.env.DEEPSEEK_API_KEY)
report.existingDecisionKeyConfigured = Boolean(process.env.AI_GATEWAY_API_KEY)
let cookie = ''
async function request(path, body) {
  const response = await fetch(new URL('/mikka' + path, 'https://app.aspectlylabs.com'), {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { origin: 'https://app.aspectlylabs.com', 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type':'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  return { response, data: await response.json().catch(() => null) }
}
try {
  if ((!isSmokeAccountEmail(email) && email !== 'alexjiang20232024@gmail.com') || !password) throw Error('preflight_account_missing')
  const version = await request('/api/version')
  if (!version.response.ok || !/^dpl_[A-Za-z0-9]+$/.test(version.data?.build ?? '')) throw Error('preflight_version_invalid')
  report.deploymentId = version.data.build
  const login = await request('/api/auth/sign-in/email', { email, password })
  if (login.response.status !== 200) throw Error('preflight_login_failed')
  cookie = login.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) throw Error('preflight_session_missing')
  const session = await request('/api/auth/get-session')
  if (session.response.status !== 200 || session.data?.user?.email?.toLowerCase() !== email.toLowerCase()) throw Error('preflight_identity_mismatch')
  const bots = await request('/api/bots')
  if (!bots.response.ok || !Array.isArray(bots.data) || !bots.data.length) throw Error('preflight_bots_missing')
  report.botCount = bots.data.length
  const menu = await request('/api/mobile/model?bot=' + encodeURIComponent(bots.data[0].id))
  if (!menu.response.ok || !Array.isArray(menu.data?.groups)) throw Error('preflight_model_menu_failed')
  const api = menu.data.groups.filter(group => group.kind === 'apiKey').flatMap(group => group.options ?? [])
  report.flashApiKeyAvailable = api.some(option => option.provider === 'deepseek' && /flash/i.test(option.modelId ?? ''))
  if (process.env.PROACTIVE_EXPECT_FLASH === '1' && !report.flashApiKeyAvailable) throw Error('preflight_flash_unavailable')
  report.modelGroupKinds = [...new Set(menu.data.groups.map(group => group.kind))].filter(value => /^[a-zA-Z]+$/.test(value))
  const runtime = await request('/api/coordinator/runtime')
  report.coordinatorAvailable = runtime.response.status === 200 && Boolean(runtime.data?.runtime?.harness)
  report.status = 'pass'
} catch(error) {
  report.status = 'fail'
  report.error = /^preflight_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'preflight_request_failed'
} finally {
  if (cookie) await request('/api/auth/sign-out', {}).catch(() => {})
  cookie = ''
}
console.log(JSON.stringify(report))
if (report.status !== 'pass') process.exitCode = 1
