import { expect, test, type Page, type Route } from '@playwright/test'

const API = '**/mikka/api/threads/00000000-0000-4000-8000-000000000072/credentials'
const SECRET = 'hunter2-secret'
const ATTEMPT = '11111111-1111-4111-8111-111111111111'
type Reply = { status?: number; json: Record<string, unknown> }

async function mock(page: Page, replies: Reply[], attempts: Reply[] = []) {
  const bodies: string[] = []
  const gets: string[] = []
  await page.route(`${API}/challenge`, route => route.fulfill({ json: { nonce: 'n'.repeat(43), origin: 'https://dash.cloudflare.com', expiresIn: 300 } }))
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '')
    expect(route.request().headers()['x-mikka-credential']).toBe('1')
    await new Promise(resolve => setTimeout(resolve, 800))
    await route.fulfill(replies.shift()!)
  })
  await page.route(`${API}/attempts/*`, async (route: Route) => {
    gets.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    await new Promise(resolve => setTimeout(resolve, 600))
    await route.fulfill(attempts.shift()!)
  })
  return { bodies, gets }
}
const site = (json: Record<string, unknown>): Reply => ({ json: { attemptId: ATTEMPT, origin: 'https://dash.cloudflare.com', ...json } })

async function open(page: Page) {
  await page.goto('/mikka/zh-CN/preview/credential-login')
  await page.getByRole('button', { name: '登录 Cloudflare' }).click()
  await expect(page.getByTestId('credential-login-card')).toBeVisible()
}
async function signIn(page: Page) {
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('pill expands with focus on email, ✕ collapses and returns focus to the pill', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('textbox', { name: '邮箱' })).toBeFocused()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: '显示密码' }).click()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text')
  await expect(page.getByText('安全保护')).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭' }).locator('svg')).toHaveAttribute('data-icon', 'inline-start')
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('button', { name: '登录 Cloudflare' })).toBeFocused()
})

test('wrong password, then an SMS code, wrong code, then signed in', async ({ page }) => {
  const { bodies } = await mock(page, [
    site({ status: 'rejected', reason: 'invalidCredentials' }),
    site({ status: 'needs_code', reason: 'twoFactorRequired', channel: 'sms' }),
    site({ status: 'rejected', reason: 'twoFactorInvalid' }),
    site({ status: 'signed_in' }),
  ])
  await open(page)
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  const card = page.getByTestId('credential-login-card')
  const submit = card.locator('button[type=submit]')
  const box = (await submit.boundingBox())!
  const cardBox = await card.boundingBox()
  await submit.click()
  await expect(submit).toBeDisabled()
  await expect(submit.getByRole('status')).toBeVisible()
  // ✕ can't race an in-flight request.
  await expect(page.getByRole('button', { name: '关闭' })).toBeDisabled()
  // No layout jump while pending.
  const pendingBox = (await submit.boundingBox())!
  expect(await card.boundingBox()).toEqual(cardBox)
  expect([pendingBox.y, pendingBox.height, pendingBox.x + pendingBox.width]).toEqual([box.y, box.height, box.x + box.width])
  await expect(page.getByText('邮箱或密码不对')).toBeVisible()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')

  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await expect(page.getByText('邮箱或密码不对')).toBeHidden()
  await submit.click()
  await expect(page.getByText('短信验证码')).toBeVisible()
  await expect(page.locator('#credential-login-code')).toBeFocused()
  await page.locator('#credential-login-code').fill('482913')
  await page.getByRole('button', { name: '验证' }).click()
  await expect(page.getByText('验证码不对')).toBeVisible()
  await page.locator('#credential-login-code').fill('482914')
  await page.getByRole('button', { name: '验证' }).click()
  await expect(page.getByTestId('credential-login-done')).toContainText('已登录 Cloudflare')

  expect(JSON.parse(bodies[0])).toMatchObject({ origin: 'https://dash.cloudflare.com', username: 'alex@mikka.app', password: SECRET })
  expect(JSON.parse(bodies[3])).toMatchObject({ code: '482914' })
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain(SECRET)
  expect(await page.content()).not.toContain(SECRET)
})

// The old card read `guarded` as a 2FA prompt and `needs_login` as a wrong password. Both mean "not in yet".
test('guarded and needs_login are waiting, never a code prompt or a wrong password', async ({ page }) => {
  await mock(page, [site({ status: 'needs_login' }), site({ status: 'guarded' }), { json: { status: 'submitted' } }])
  await open(page)
  await signIn(page)
  const notice = page.getByTestId('credential-login-notice')
  await expect(notice).toContainText('已提交，等待网站结果…')
  await expect(page.getByText('邮箱或密码不对')).toHaveCount(0)
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(notice).toContainText('已提交，等待网站结果…')
  await expect(page.locator('#credential-login-code')).toHaveCount(0)
  await expect(page.getByTestId('credential-login-done')).toHaveCount(0)
  // A response with no attemptId can't be re-checked, so no button.
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(notice.getByRole('button')).toHaveCount(0)
})

test('needs_login after a code is not a wrong code', async ({ page }) => {
  await mock(page, [site({ status: 'needs_code', reason: 'twoFactorRequired' }), site({ status: 'needs_login' })])
  await open(page)
  await signIn(page)
  await expect(page.getByText('验证码', { exact: true })).toBeVisible()
  await page.locator('#credential-login-code').fill('482913')
  await page.getByRole('button', { name: '验证' }).click()
  await expect(page.getByTestId('credential-login-notice')).toContainText('已提交，等待网站结果…')
  await expect(page.getByText('验证码不对')).toHaveCount(0)
})

test('unknown outcome offers a single re-check via GET attempts', async ({ page }) => {
  const { gets } = await mock(page, [site({ status: 'unknown', reason: 'outcomeUnknown' })], [site({ status: 'signed_in' })])
  await open(page)
  await signIn(page)
  const recheck = page.getByRole('button', { name: '再查一次' })
  await expect(page.getByText('没能确认是否已登录')).toBeVisible()
  await recheck.click()
  await expect(recheck).toBeDisabled()
  await expect(recheck.getByRole('status')).toBeVisible()
  await expect(page.getByTestId('credential-login-done')).toBeVisible()
  expect(gets).toEqual([`GET /mikka/api/threads/00000000-0000-4000-8000-000000000072/credentials/attempts/${ATTEMPT}`])
})

test('rate limit, lock, captcha, unknown reason and Mikka errors each get their copy', async ({ page }) => {
  await mock(page, [
    site({ status: 'rejected', reason: 'rateLimited', retryAfterSeconds: 30 }),
    site({ status: 'rejected', reason: 'accountLocked' }),
    site({ status: 'needs_user', reason: 'captchaRequired' }),
    site({ status: 'rejected', reason: 'somethingNew' }),
    { status: 409, json: { error: 'credential_login_pending' } },
    { status: 404, json: { error: 'credential_denied' } },
  ])
  await open(page)
  for (const text of ['尝试太频繁，30 秒后再试', '账号已被锁定', '需要你亲自完成网站的人机验证', '登录被拒绝', '已提交，等待网站结果…', '这里不允许登录']) {
    await signIn(page)
    await expect(page.getByText(text)).toBeVisible()
  }
})

test('server failure keeps the form and shows a retry message', async ({ page }) => {
  await page.route(`${API}/challenge`, route => route.fulfill({ status: 503, json: { error: 'credential_unavailable' } }))
  await open(page)
  await signIn(page)
  await expect(page.getByText('没登上，再试一次')).toBeVisible()
})

test('a result for the old credential API is dropped once the prefix changes', async ({ page }) => {
  await mock(page, [site({ status: 'signed_in' })])
  await page.route('**/mikka/api/threads/00000000-0000-4000-8000-000000000073/credentials/**', route => route.abort())
  await open(page)
  await signIn(page)
  // Swap the thread while the old POST is still held by the mock (800 ms).
  await page.evaluate(() => window.history.pushState(null, '', '?run=00000000-0000-4000-8000-000000000073'))
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('credential-login-done')).toHaveCount(0)
  // Not stuck pending: the form takes a new password for the new thread.
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
})
