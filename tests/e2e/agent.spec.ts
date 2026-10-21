import { test, expect, register } from './fixtures'

test('Agent 嵌入 OpenUI，支持重新加载且保留工作区导航', async ({ page }) => {
  const externalUrl = 'https://www.openui.com/demo/intelligent-ui'
  let requests = 0
  await page.route(externalUrl, async route => {
    requests++
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>嵌入测试</title></head><body><label>测试输入<textarea></textarea></label></body></html>' })
  })
  await register(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open Intelligent UI', exact: true })).toBeVisible()
  const frame = page.locator('iframe[title="Open Intelligent UI 交互界面"]')
  await expect(frame).toHaveAttribute('src', externalUrl)
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox')
  await expect(frame.contentFrame().getByLabel('测试输入')).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByText('未连接 Orvilo 工作区数据', { exact: false })).toBeVisible()
  const externalLink = page.getByRole('link', { name: /独立打开/ })
  await expect(externalLink).toHaveAttribute('href', externalUrl)
  await expect(externalLink).toHaveAttribute('target', '_blank')
  await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer')

  await frame.contentFrame().getByLabel('测试输入').fill('嵌入交互测试')
  await expect(frame.contentFrame().getByLabel('测试输入')).toHaveValue('嵌入交互测试')
  await page.getByRole('button', { name: '重新加载 Agent 界面', exact: true }).click()
  await expect.poll(() => requests).toBe(2)
  await expect(frame.contentFrame().getByLabel('测试输入')).toHaveValue('')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame).toBeVisible()
  await expect(externalLink).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1159, height: 851 })
  await page.getByRole('button', { name: '我的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我创建的任务', exact: true })).toBeVisible()
  await expect(frame).toHaveCount(0)
})
