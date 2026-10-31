import { app, expect, test } from './fixtures'

// 入口兼容性只需 HTTP 请求，不启动账户测试的浏览器或创建用户。
test('旧预览入口和设置入口均跳转到正式页面', { tag: '@smoke' }, async ({ request }) => {
  const routes = [
    ['/preview', '/'],
    ['/preview?next=https%3A%2F%2Fexample.com', '/'],
    ['/preview/settings', '/settings/members'],
    ['/preview/settings?workspace=route-check&invite=1', '/settings/members?workspace=route-check&invite=1'],
  ]

  for (const [source, target] of routes) {
    const response = await request.get(app(source), { maxRedirects: 0 })
    expect(response.status(), source).toBe(307)
    const destination = new URL(response.headers().location, response.url())
    expect(destination.origin, source).toBe(new URL(response.url()).origin)
    // Next writes redirect('/') under a base path as /mikka/, which then settles on /mikka.
    expect(`${destination.pathname.replace(/\/$/, '')}${destination.search}`, source).toBe(app(target))
  }
})

test('匿名访问旧设置入口会重定向到登录页并保留设置路径', { tag: '@smoke' }, async ({ page }) => {
  await page.goto(app('/preview/settings'))
  await expect(page).toHaveURL(url => url.pathname === app('/sign-in') && url.searchParams.get('next') === '/settings/members')
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible()
})

test('桌面登录入口在服务端解析后保留回调和状态', async ({ page }) => {
  const state = 'abcdefghijklmnop1234'
  const callback = 'http://127.0.0.1:49152/auth/callback'
  const query = new URLSearchParams({ desktop: '1', desktop_state: state, desktop_next: '/', desktop_callback: callback })
  const response = await page.goto(app(`/en/sign-in?${query}`))
  expect(response?.status()).toBe(200)
  const html = await response!.text()
  // AuthForm's server-rendered props must contain the canonical desktop flow.
  const serializedFlow = JSON.stringify({ state, next: '/', callback }).replaceAll('"', '\\"')
  expect(html).toContain(`\\"desktopFlow\\":${serializedFlow}`)
  await expect(page.getByRole('status')).toHaveText('Click the provider button to finish OAuth authorization in this tab.')
})
