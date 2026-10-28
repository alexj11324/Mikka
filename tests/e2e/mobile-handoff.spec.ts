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
