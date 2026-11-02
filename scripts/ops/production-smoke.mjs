import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'

const features = new Set(['coordinator', 'credentialVault', 'approvedWrites', 'cloudComputer'])

/** Normal sign-in followed by reads only. Cookies and response bodies stay in memory. */
export async function runSmoke({ env = process.env, fetchImpl = fetch } = {}) {
  const { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password } = env
  if (!isSmokeAccountEmail(email) || !password) throw new Error('smoke_account_required')
  const target = new URL(env.SMOKE_BASE_URL ?? 'https://app.aspectlylabs.com')
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error('smoke_origin_invalid')
  if (target.username || target.password || target.search || target.hash || !['/', '/mikka', '/mikka/'].includes(target.pathname)) throw new Error('smoke_origin_invalid')
  const expected = new Set((env.SMOKE_EXPECT_ON ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if ([...expected].some(feature => !features.has(feature))) throw new Error('smoke_feature_invalid')
  const results = []
  let cookie = ''
  async function request(path, init = {}) {
    try {
      return await fetchImpl(new URL(`/mikka${path}`, target.origin), {
        ...init,
        headers: { 'cache-control': 'no-store', origin: target.origin, ...(cookie ? { cookie } : {}), ...init.headers },
        // A redirect must never forward the account's credentials or session.
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch { throw new Error('smoke_request_failed') }
  }
  async function probe(feature, path, valid) {
    const response = await request(path)
    const body = await response.json().catch(() => null)
    results.push({ feature, status: response.status, on: response.status === 200 && valid(body) })
    return body
  }
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  if (login.status !== 200) throw new Error('smoke_sign_in_failed')
  cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) throw new Error('smoke_session_cookie_missing')
  const session = await request('/api/auth/get-session')
  const identity = await session.json().catch(() => null)
  if (session.status !== 200 || identity?.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('smoke_session_invalid')
  const shell = await request('/en')
  if (shell.status !== 200 || !shell.headers.get('content-type')?.includes('text/html')) throw new Error('smoke_shell_failed')
  // Consume without retaining rendered account data in the report.
  await shell.arrayBuffer()
  await probe('coordinator', '/api/coordinator/runtime', body => Boolean(body?.runtime?.harness))
  await probe('credentialVault', '/api/credentials', body => Array.isArray(body?.logins))
  await probe('approvedWrites', '/api/approved-writes', body => body?.enabled === true)
  const botsResponse = await request('/api/bots')
  const bots = await botsResponse.json().catch(() => null)
  const bot = botsResponse.status === 200 && Array.isArray(bots) ? bots.find(item => item.name === 'Smoke Bot') : null
  if (!bot || !/^[0-9a-f-]{36}$/i.test(bot.id)) throw new Error('smoke_bot_missing')
  // Unlike /computer, this endpoint never contacts or boots an E2B machine.
  await probe('cloudComputer', `/api/bots/${bot.id}/computer/runtimes`, body => Array.isArray(body?.runtimes))
  const healthy = results.every(result => result.on || (result.feature !== 'coordinator' && !expected.has(result.feature)))
  return { status: healthy ? 'pass' : 'fail', results }
}

export function markdown(report) {
  return ['## Production API smoke', '', `Result: ${report.status}`, '', '| Feature | On | HTTP |', '| --- | --- | --- |',
    ...report.results.map(result => `| ${result.feature} | ${result.on ? 'yes' : 'no'} | ${result.status} |`), ''].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await runSmoke() }
  catch (error) {
    const code = error instanceof Error && /^smoke_[a-z_]+$/.test(error.message) ? error.message : 'smoke_failed'
    report = { status: 'fail', error: code, results: [] }
  }
  mkdirSync('production-smoke-report', { recursive: true })
  writeFileSync('production-smoke-report/results.json', `${JSON.stringify(report, null, 2)}\n`)
  const summary = `${markdown(report)}${report.error ? `\nError: ${report.error}\n` : ''}`
  writeFileSync('production-smoke-report/summary.md', summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
  if (report.status !== 'pass') process.exitCode = 1
}
