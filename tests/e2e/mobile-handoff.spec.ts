import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app, captureAuthenticationCookies } from './fixtures'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'

// Credentials and the URL token must never enter traces or automatic screenshots.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('native session hands off through a real browser confirmation without silently replacing its account', async ({ page, browser, baseURL }) => {
  await register(page)
  const nativeSession = await (await page.request.get(app('/api/auth/get-session'))).json()
  const browserContext = await browser.newContext({ baseURL, locale: 'zh-CN' })
  try {
    const browserPage = await browserContext.newPage()
    await register(browserPage)
    const previous = await (await browserPage.request.get(app('/api/auth/get-session'))).json()
    expect(previous.user.id === nativeSession.user.id).toBe(false)
    const generated = await page.request.get(app('/api/auth/one-time-token/generate'))
    expect(generated.status()).toBe(200)
    const { token } = await generated.json()
    expect(typeof token).toBe('string')
    await recordAuthenticationSecrets([token])
    const target = new URL(app('/api/mobile/open'), baseURL)
    target.search = new URLSearchParams({ token, to: '/?section=coordinator' }).toString()
    // evaluate arguments are private, unlike Playwright's rendered goto(URL) title.
    await browserPage.evaluate(url => { window.location.assign(url) }, target.href)
    await expect(browserPage.getByRole('heading', { name: '登录 Mikka', exact: true })).toBeVisible()
    await expect(browserPage.getByText(nativeSession.user.email, { exact: true })).toBeVisible()
    const unchanged = await (await browserPage.request.get(app('/api/auth/get-session'))).json()
    expect(unchanged.user.id === previous.user.id).toBe(true)
    const rejected = await browserPage.request.post(app('/api/mobile/open'), { headers: { origin: 'https://foreign.example' }, form: { csrf: 'untrusted' } })
    expect(rejected.status()).toBe(403)
    await browserPage.getByRole('button', { name: '使用此账号继续', exact: true }).click()
    await expect(browserPage).toHaveURL(url => url.pathname === app('/') && url.searchParams.get('section') === 'coordinator')
    const confirmed = await (await browserPage.request.get(app('/api/auth/get-session'))).json()
    expect(confirmed.user.id === nativeSession.user.id).toBe(true)
    await captureAuthenticationCookies(browserContext)
    // Real HTTP replay, without including the URL token in an instrumented API step.
    const replay = await fetch(target, { redirect: 'manual' })
    expect(replay.status).toBe(303)
    expect(replay.headers.has('set-cookie')).toBe(false)
    await replay.body?.cancel()
    const nativeStillActive = await (await page.request.get(app('/api/auth/get-session'))).json()
    expect(nativeStillActive.user.id === nativeSession.user.id).toBe(true)
  } finally {
    await captureAuthenticationCookies(browserContext)
    await browserContext.close()
  }
})


test('mobile decisions enforce owner, origin, expiry and single consumption on real SQL rows', async ({ page, baseURL }) => {
  const connection = process.env.E2E_DATABASE_URL
  if (!connection) throw new Error('Isolated E2E database is required')
  const database = new URL(connection)
  if (process.env.GITHUB_ACTIONS !== 'true' || database.hostname !== '127.0.0.1' || database.port !== '5432' || database.pathname !== '/mikka_e2e' || database.search || process.env.VERCEL === '1' || process.env.AI_GATEWAY_API_KEY || process.env.MIKKA_NATIVE_COORDINATOR === '1') throw new Error('Requires Actions loopback database with model execution disabled')
  await register(page)
  const owner = await (await page.request.get(app('/api/auth/get-session'))).json()
  const pool = new Pool({ connectionString: connection, max: 1 })
  const own = randomUUID(), expired = randomUUID(), foreign = randomUUID()
  const origin = new URL(baseURL!).origin
  const decide = (id: string, approve: unknown = false, source = origin) => page.request.post(app(`/api/mobile/pending-actions/${id}`), { headers: { origin: source }, data: { approve } })
  try {
    const input = { to: ['synthetic@example.invalid'], subject: 'Retained fixture', body: 'No provider call is authorized by this test.' }
    await pool.query(`INSERT INTO pending_actions (id, "userId", action, input, "createdAt") VALUES ($1,$2,'send_email',$3,now()), ($4,$2,'send_email',$3,now()-interval '8 days'), ($5,$6,'send_email',$3,now())`, [own, owner.user.id, input, expired, foreign, `foreign-${randomUUID()}`])
    expect((await decide(own, false, 'https://foreign.example')).status()).toBe(403)
    expect((await decide(own, 'false')).status()).toBe(400)
    expect((await decide(foreign)).status()).toBe(409)
    expect((await decide(expired)).status()).toBe(409)
    const declined = await decide(own)
    expect(declined.status()).toBe(200)
    expect((await declined.json()).status).toBe('declined')
    expect((await decide(own)).status()).toBe(409)
    const anonymous = await fetch(new URL(app(`/api/mobile/pending-actions/${foreign}`), baseURL), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ approve: false }) })
    expect(anonymous.status).toBe(401)
    await anonymous.body?.cancel()
    const rows = await pool.query('SELECT id,status FROM pending_actions WHERE id=ANY($1::uuid[])', [[own, expired, foreign]])
    const statuses = new Map(rows.rows.map(row => [row.id, row.status]))
    expect(statuses.get(own)).toBe('declined')
    expect(statuses.get(expired)).toBe('pending')
    expect(statuses.get(foreign)).toBe('pending')
  } finally {
    // Preserve all fixture and audit rows; release only the client connection.
    await pool.end()
  }
})
