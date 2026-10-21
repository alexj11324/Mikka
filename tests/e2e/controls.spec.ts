import { test, expect, register, watchRuntime } from './fixtures'
import { controlsSelector, clickWithEffect, inspectControl } from './control-audit'
import type { Page } from '@playwright/test'

const surfaces: { name: string; scope?: 'dialog' | 'menu'; prepare: (page: Page) => Promise<void> }[] = [
  { name: '工作台', prepare: async page => {
    await page.goto('/')
    await page.getByRole('button', { name: '我创建的', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我创建的', exact: true })).toBeVisible()
  } },
  { name: '成员管理', prepare: async page => {
    await page.goto('/settings/members')
    await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toBeEnabled()
  } },
  { name: '邀请弹窗', scope: 'dialog', prepare: async page => {
    await page.goto('/settings/members')
    await page.getByRole('button', { name: '邀请成员', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '邀请成员', exact: true })).toBeVisible()
  } },
  { name: '新建任务', scope: 'dialog', prepare: async page => {
    await page.goto('/')
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await expect(page.getByLabel('任务标题', { exact: true })).toBeVisible()
  } },
  { name: '任务状态菜单', scope: 'menu', prepare: async page => {
    await page.goto('/')
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await page.getByRole('button', { name: /^任务状态：/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
  } },
  { name: '账户菜单', scope: 'menu', prepare: async page => {
    await page.goto('/')
    await page.getByRole('button', { name: '账户菜单', exact: true }).click()
    await expect(page.getByRole('menu')).toBeVisible()
  } },
]

for (const surface of surfaces) {
  test(`自动发现可见控件并验证点击效果：${surface.name}`, async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(180000)
    await register(page)
    const storageState = await page.context().storageState()
    await surface.prepare(page)
    const root = surface.scope ? page.getByRole(surface.scope) : page
    const controls = await root.locator(controlsSelector).all()
    expect(controls.length, '扫描不能空跑').toBeGreaterThan(0)
    // 打开独立页面可能让原菜单失焦关闭，必须在此前冻结完整清单，而非保留动态 nth 定位器。
    const candidates = await Promise.all(controls.map(control => inspectControl(control, page)))
    const coverage: { label: string; status: string }[] = []
    const failures: string[] = []
    for (const [index, { label, skip }] of candidates.entries()) {
      if (skip) { coverage.push({ label, status: skip }); continue }
      await test.step(`点击 ${label}`, async () => {
        // 每个候选控件使用独立页面与同一服务端会话，避免上一次的菜单/导航污染下一次。
        const context = await browser.newContext({ baseURL, storageState })
        const runtimeErrors = watchRuntime(context)
        try {
          const isolated = await context.newPage()
          await surface.prepare(isolated)
          const isolatedRoot = surface.scope ? isolated.getByRole(surface.scope) : isolated
          const candidate = isolatedRoot.locator(controlsSelector).nth(index)
          expect((await inspectControl(candidate, isolated)).label, '页面恢复后控件身份必须一致').toBe(label)
          await clickWithEffect(isolated, candidate)
          expect(runtimeErrors, '点击不得伴随运行异常').toEqual([])
          coverage.push({ label, status: '已点击且有可观察变化' })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          failures.push(`${label}: ${detail}`)
          coverage.push({ label, status: '失败' })
          const failedPage = context.pages()[0]
          if (failedPage) {
            await testInfo.attach(`失败控件-${index}`, { body: await failedPage.screenshot(), contentType: 'image/png' })
          }
        } finally { await context.close() }
      })
    }
    await testInfo.attach('可见控件覆盖明细', { body: JSON.stringify(coverage, null, 2), contentType: 'application/json' })
    expect(coverage.filter(item => item.status === '已点击且有可观察变化').length, '每个页面至少实际点击一个控件').toBeGreaterThan(0)
    expect(failures, '所有未豁免的可见控件必须响应').toEqual([])
  })
}
