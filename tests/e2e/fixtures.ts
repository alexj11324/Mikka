import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

// The app is served under next.config.mjs's basePath. page.goto('/x') resolves
// against the origin, so app paths go through app().
export const BASE_PATH = '/mikka'
export function app(path: string) {
  if (path === '/' || path.startsWith('/?')) return `${BASE_PATH}${path.slice(1)}`
  return `${BASE_PATH}${path}`
}

export function watchRuntime(context: BrowserContext) {
  const failures: string[] = []
  context.on('page', page => {
    page.on('pageerror', error => failures.push(error.stack ?? error.message))
    page.on('console', message => {
      if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
    })
    page.on('response', response => {
      if (response.status() >= 500 && new URL(response.url()).origin === new URL(page.url()).origin) {
        failures.push(`HTTP ${response.status()}: ${response.url()}`)
      }
    })
  })
  return failures
}

export function browserClientHeaders() {
  // 独立测试客户端使用基准测试保留网段，避免共享 CI 来源耗尽生产限流；不修改应用限流规则。
  return { 'x-forwarded-for': `198.18.${randomInt(256)}.${randomInt(1, 255)}` }
}

export const test = base.extend<{ runtimeGuard: void }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, ...browserClientHeaders() })
  },
  runtimeGuard: [async ({ context }, use, testInfo) => {
    const failures = watchRuntime(context)
    await use()
    if (failures.length) await testInfo.attach('runtime-errors', { body: failures.join('\n\n'), contentType: 'text/plain' })
    expect(failures, '页面异常、console.error 或服务端 5xx 不得被忽略').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function register(page: Page, next = '/', email = `e2e-${randomUUID()}@example.com`) {
  const password = randomBytes(32).toString('base64url')
  await page.goto(app(`/sign-up?next=${encodeURIComponent(next)}`))
  await page.getByLabel('称呼', { exact: true }).fill('回归测试成员')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  // Better Auth 的生产规则为同一来源每 10 秒最多注册 3 次；CI 所有浏览器共享来源。
  await delay(4000)
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
  await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === app(next))
  return { email, password }
}
