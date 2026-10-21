import type { Page, TestInfo } from '@playwright/test'
import { test, expect, register } from './fixtures'

const budgetMs = 1000

type Destination = { path: string; selectors: string[]; text?: string; query?: string }
type NavigationSample = { start: number | null; complete: number | null; pathname: string }
declare global { interface Window { __navigationSample?: NavigationSample } }

async function measureNavigation(page: Page, info: TestInfo, name: string, destination: Destination, navigate: () => Promise<unknown>) {
  await page.evaluate(({ path, selectors, text, query }) => {
    const sample: NavigationSample = { start: null, complete: null, pathname: path }
    window.__navigationSample = sample
    document.addEventListener('click', () => {
      sample.start = performance.now()
      let readyFrames = 0
      function check() {
        const elements = selectors.map(selector => document.querySelector<HTMLElement>(selector))
        const ready = location.pathname === path && (!query || location.search.includes(query)) &&
          elements.every(element => element && element.getBoundingClientRect().height > 0 && !element.matches(':disabled')) &&
          (!text || elements.some(element => element?.textContent?.includes(text))) &&
          !document.querySelector('[data-settings-state="loading"], [data-settings-state="error"]')
        readyFrames = ready ? readyFrames + 1 : 0
        if (readyFrames >= 2) sample.complete = performance.now()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }, { once: true, capture: true })
  }, destination)
  const requests: { url: string; ms: number }[] = []
  const record = (response: import('@playwright/test').Response) => {
    const request = response.request()
    if (new URL(response.url()).origin !== new URL(page.url()).origin) return
    const timing = request.timing()
    requests.push({ url: new URL(response.url()).pathname, ms: timing.responseEnd })
  }
  page.on('response', record)
  try {
    await navigate()
    await page.waitForFunction(() => window.__navigationSample?.complete != null, undefined, { timeout: 15000, polling: 'raf' })
    const sample = await page.evaluate(() => window.__navigationSample!)
    const elapsedMs = sample.complete! - sample.start!
    await info.attach(`navigation-${name}`, { contentType: 'application/json', body: JSON.stringify({ name, elapsedMs, budgetMs, destination, viewport: page.viewportSize(), requests }, null, 2) })
    expect(elapsedMs, `${name}：从真实点击到数据内容连续两帧可见，不能只出现标题、URL 或骨架屏`).toBeLessThanOrEqual(budgetMs)
  } finally {
    page.off('response', record)
  }
}

const members: Destination = { path: '/settings/members', selectors: ['[data-settings-state="ready"]', 'input[aria-label="搜索成员或邀请"]', 'main table tbody'], text: '回归测试成员' }
const teams: Destination = { path: '/settings/teams', selectors: ['[data-settings-state="ready"]', 'input[aria-label="搜索团队"]'], text: '创建第一个公开团队' }
const preferences: Destination = { path: '/settings', query: 'section=preferences', selectors: ['main [aria-label="界面主题"]', 'main button[aria-label="浅色"]'] }
const profile: Destination = { path: '/settings', query: 'section=profile', selectors: ['main section[aria-labelledby="profile-heading"]'], text: '回归测试成员' }
const workspace: Destination = { path: '/settings', query: 'section=workspace', selectors: ['main section[aria-label="工作区基本信息"]', '#workspace-name', '#workspace-url'] }

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const first of ['成员', '团队'] as const) {
    test(`首访${first}、设置互切与缓存返回均不超过 1 秒 (${viewport.width}px)`, { tag: '@performance' }, async ({ page }, info) => {
      await page.setViewportSize(viewport)
      // 不等待预取、networkidle 或固定休眠；注册后即可按用户路径点击。
      await register(page)
      async function sidebarLink(name: string) {
        if (viewport.width < 768) {
          await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
          const dialog = page.getByRole('dialog')
          await expect(dialog).toBeVisible()
          return dialog.getByRole('link', { name, exact: true })
        }
        return page.locator('[data-slot="sidebar-container"]').getByRole('link', { name, exact: true })
      }
      if (viewport.width < 768) await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
      await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
      await measureNavigation(page, info, '工作台进入设置', { path: '/settings', selectors: preferences.selectors }, () => page.getByRole('menuitem', { name: '设置', exact: true }).click())
      const initial = first === '成员' ? members : teams
      const other = first === '成员' ? teams : members
      for (const [name, destination] of [[first, initial], [first === '成员' ? '团队' : '成员', other]] as const) {
        const link = await sidebarLink(name)
        await measureNavigation(page, info, `首次进入${name}`, destination, () => link.click())
      }
      for (let round = 1; round <= 3; round++) {
        for (const [name, destination] of [['个人资料', profile], ['成员', members], ['团队', teams], ['工作区', workspace], ['偏好设置', preferences]] as const) {
          const link = await sidebarLink(name)
          await measureNavigation(page, info, `${name}-缓存返回-${round}`, destination, () => link.click())
        }
      }
      const directory = await sidebarLink('团队')
      await measureNavigation(page, info, '团队目录返回', teams, () => directory.click())
      await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
      const form = page.getByRole('form', { name: '创建新团队', exact: true })
      await form.getByLabel('团队名称', { exact: true }).fill('性能门禁团队')
      await form.getByLabel('团队标识', { exact: true }).fill('PERF')
      await form.getByRole('button', { name: '创建团队', exact: true }).click()
      const options = page.getByRole('region', { name: '团队设置选项', exact: true })
      await expect(options).toBeVisible()
      await measureNavigation(page, info, '团队常规设置', { path: '/settings/teams', query: 'view=general', selectors: ['form[aria-label="团队常规设置"]', '#team-identifier'] }, () => options.getByRole('link', { name: '常规设置', exact: true }).click())
      await page.getByRole('button', { name: '团队设置', exact: true }).click()
      await expect(options).toBeVisible()
      await measureNavigation(page, info, '团队成员', { path: '/settings/teams', query: 'view=members', selectors: ['section[aria-label="性能门禁团队 · 团队成员"] table tbody'], text: '回归测试成员' }, () => options.getByRole('link', { name: '成员', exact: true }).click())
      // 真实输入验证内容已水合、可操作，而不是仅服务器 HTML 可见。
      const memberLink = await sidebarLink('成员')
      await measureNavigation(page, info, '成员可操作', members, () => memberLink.click())
      await page.getByRole('textbox', { name: '搜索成员或邀请', exact: true }).fill('不匹配的搜索词')
      await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toHaveCount(0)
    })
  }
}
