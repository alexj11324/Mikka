import { expect, test, type Page, type Route } from '@playwright/test'

const API = '**/mikka/api/threads/00000000-0000-4000-8000-000000000072/credentials'
const SECRET = 'hunter2-secret'

async function mock(page: Page, results: Array<{ status: string }>) {
  const bodies: string[] = []
  await page.route(`${API}/challenge`, route => route.fulfill({ json: { nonce: 'n'.repeat(43), origin: 'https://dash.cloudflare.com', expiresIn: 300 } }))
  await page.route(API, async (route: Route) => {
    bodies.push(route.request().postData() ?? '')
    expect(route.request().headers()['x-mikka-credential']).toBe('1')
    await new Promise(resolve => setTimeout(resolve, 300))
    await route.fulfill({ json: results.shift() })
  })
  return bodies
}

async function open(page: Page) {
  await page.goto('/mikka/zh-CN/preview/credential-login')
  await page.getByRole('button', { name: '登录 Cloudflare' }).click()
  await expect(page.getByTestId('credential-login-card')).toBeVisible()
}

test('pill expands in place and ✕ collapses it back', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('textbox', { name: '邮箱' })).toBeVisible()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: '显示密码' }).click()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('button', { name: '登录 Cloudflare' })).toBeVisible()
})

test('wrong password, then two-step code, then signed in', async ({ page }) => {
  const bodies = await mock(page, [{ status: 'needs_login' }, { status: 'guarded' }, { status: 'resumed' }])
  await open(page)
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  const submit = page.getByRole('button', { name: '登录', exact: true })
  const box = await submit.boundingBox()
  await submit.click()
  await expect(submit).toBeDisabled()
  await expect(submit.getByRole('status')).toBeVisible()
  expect(await submit.boundingBox()).toEqual(box)
  await expect(page.getByText('密码不对')).toBeVisible()
  // The secret left the input as soon as it was sent.
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')

  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await expect(page.getByText('密码不对')).toBeHidden()
  await submit.click()
  await expect(page.getByText('验证码', { exact: true })).toBeVisible()
  await page.keyboard.type('482913')
  await page.getByRole('button', { name: '验证' }).click()
  await expect(page.getByTestId('credential-login-done')).toContainText('已登录 Cloudflare')

  expect(JSON.parse(bodies[0])).toMatchObject({ origin: 'https://dash.cloudflare.com', username: 'alex@mikka.app', password: SECRET })
  expect(JSON.parse(bodies[2])).toMatchObject({ code: '482913' })
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain(SECRET)
  expect(await page.content()).not.toContain(SECRET)
})

test('server failure keeps the form and shows a retry message', async ({ page }) => {
  await page.route(`${API}/challenge`, route => route.fulfill({ status: 503, json: { error: 'credential_unavailable' } }))
  await open(page)
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('没登上，再试一次')).toBeVisible()
})
