import { test, expect } from './fixtures'
import { clickWithEffect } from './control-audit'

for (const handler of ['', 'console.log("没有业务效果")', 'void fetch("/poll")']) {
  test(`点击断言拒绝无效果控件：${handler || '空处理函数'}`, async ({ page }) => {
    await page.route('**/poll', route => route.fulfill({ body: '{}' }))
    await page.route('**/control-audit-fixture', route => route.fulfill({ contentType: 'text/html', body: '<button type="button">检查控件</button>' }))
    await page.goto('/control-audit-fixture')
    await page.getByRole('button').evaluate((element, code) => {
      element.addEventListener('click', () => { Function(code)() })
    }, handler)
    await expect(clickWithEffect(page, page.getByRole('button'))).rejects.toThrow('点击后必须有')
  })
}

test('点击断言接受真实界面变化', async ({ page }) => {
  await page.setContent('<button type="button">展开</button><section hidden>内容已展开</section>')
  await page.getByRole('button').evaluate(element => {
    element.addEventListener('click', () => { document.querySelector('section')!.hidden = false })
  })
  await clickWithEffect(page, page.getByRole('button'))
  await expect(page.getByText('内容已展开')).toBeVisible()
})
