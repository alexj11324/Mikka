import { randomBytes, randomUUID } from 'node:crypto'
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

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

export const test = base.extend<{ runtimeGuard: void }>({
  runtimeGuard: [async ({ context }, use, testInfo) => {
    const failures = watchRuntime(context)
    await use()
    if (failures.length) await testInfo.attach('runtime-errors', { body: failures.join('\n\n'), contentType: 'text/plain' })
    expect(failures, '页面异常、console.error 或服务端 5xx 不得被忽略').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function register(page: Page, next = '/', email = `e2e-${randomUUID()}@example.com`) {
  const password = randomBytes(32).toString("base64url")
  await page.goto(`/sign-up?next=${encodeURIComponent(next)}`)
  await page.getByLabel('称呼', { exact: true }).fill('回归测试成员')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click()
  await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === next)
  return { email, password }
}
