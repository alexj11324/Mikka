import { test, expect } from '@playwright/test'
import { app } from './fixtures'

// 入口兼容性只需 HTTP 请求，不启动账户测试的浏览器或创建用户。
test('旧预览入口和设置入口均跳转到正式页面', async ({ request }) => {
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

  const settings = await request.get(app('/preview/settings'))
  const signIn = new URL(settings.url())
  expect(settings.status()).toBe(200)
  expect(signIn.pathname).toBe(app('/sign-in'))
  expect(signIn.searchParams.get('next')).toBe('/settings/members')
})
