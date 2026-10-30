import { test, expect, register, app, openCreateIssue } from './fixtures'

const schemes = ['light', 'dark'] as const

test.describe('E2B 机器名截图', () => {
  test.setTimeout(240_000)
  for (const colorScheme of schemes) {
    test(`新建任务：E2B 选中、下拉、休眠/唤醒、移动端 ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme })
      await register(page, '/')
      const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`shots/fe7-${name}-${colorScheme}.png`) })
      for (const machine of ['sleeping', 'waking'] as const) {
        await page.unroute('**/api/bots/*/computer')
        await page.route('**/api/bots/*/computer', route => route.request().method() === 'GET' ? route.fulfill({ json: { machine, control: 'idle' } }) : route.fallback())
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(app('/'))
        const dialog = await openCreateIssue(page)
        const trigger = dialog.getByRole('combobox', { name: '运行的机器', exact: true })
        await expect(trigger).toContainText('E2B')
        await shot(`dialog-e2b-${machine}`)
        if (machine === 'sleeping') {
          await trigger.click()
          await expect(page.getByRole('option', { name: /E2B/ })).toBeVisible()
          await shot('dropdown-open')
          await page.keyboard.press('Escape')
        }
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(app('/'))
      const dialog = await openCreateIssue(page)
      await expect(dialog.getByRole('combobox', { name: '运行的机器', exact: true })).toContainText('E2B')
      await shot('mobile-chips')
    })
  }
})

// The real ComputerCard from a stored agent reply. The reply lives only in this fixture; a demo- bot id uses
// the existing client-side mock computer (?computer-mock=sleep starts it asleep, 唤醒 moves it to waking).
async function seedReply(email: string, content: string) {
  const { randomUUID } = await import('node:crypto')
  const { Pool } = await import('pg')
  const url = process.env.E2E_DATABASE_URL
  if (!url) throw new Error('Computer card shots require an isolated E2E_DATABASE_URL')
  const target = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const messages = [{ role: 'user', content: '打开预览部署截一张首页' }, { role: 'assistant', content }]
    for (const [index, message] of messages.entries()) await pool.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1, $2, $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
  } finally { await pool.end() }
}

for (const colorScheme of schemes) {
  test(`电脑卡片：休眠与唤醒 ${colorScheme}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000)
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 1280, height: 800 })
    const { email } = await register(page)
    await seedReply(email, 'root = Stack([computer])\ncomputer = ComputerCard("demo-fe7", "run-demo-fe7", "打开预览部署，用测试账号登录，截一张首页。", "working", "Mikka Frontend", "预览部署检查")')
    await page.goto(app('/?section=coordinator&computer-mock=sleep'))
    const region = page.getByRole('region', { name: 'Coordinator', exact: true })
    await expect(region.getByText('休眠中', { exact: true }).first()).toBeVisible()
    await expect(region.getByText('E2B', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`shots/fe7-card-sleeping-${colorScheme}.png`) })
    // The 唤醒 cover sits inside the card's open-screen button, so it is a presentational child in the
    // accessibility tree; reach it by text and close the viewer the outer button opens.
    await region.locator('button', { hasText: '唤醒' }).last().click()
    if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
    await expect(region.getByText('唤醒中', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`shots/fe7-card-waking-${colorScheme}.png`) })
  })
}
