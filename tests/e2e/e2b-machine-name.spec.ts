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
