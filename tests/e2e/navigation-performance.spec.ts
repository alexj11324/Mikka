import type { Page, TestInfo } from '@playwright/test'
import { test, expect, register, BASE_PATH } from './fixtures'

test('移动侧栏在水合与尺寸检测完成前不可点击，就绪后首次点击即可打开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await register(page)

  let releaseScripts!: () => void
  const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve })
  await page.route('**/*.js', async route => {
    await scriptsReady
    await route.continue()
  })
  try {
    await page.reload({ waitUntil: 'commit' })
    const trigger = page.getByRole('button', { name: '展开或收起侧栏', exact: true })
    await expect(trigger).toBeVisible()
    await expect(trigger).toBeDisabled()
    releaseScripts()
    await expect(trigger).toBeEnabled()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.click()
    await expect(page.getByRole('dialog')).toBeVisible()
  } finally {
    releaseScripts()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

// 本地目标 1000ms；GitHub Actions 共享机器抖动大，CI 上留 20% 余量（MIK-1）。
const budgetMs = process.env.CI ? 1200 : 1000

type Destination = { path: string; selectors: string[]; text?: string; query?: string }
type NavigationSample = { start: number | null; complete: number | null; pathname: string }
declare global { interface Window { __navigationSample?: NavigationSample } }

async function measureNavigation(page: Page, info: TestInfo, name: string, destination: Destination, navigate: () => Promise<unknown>) {
  await page.evaluate(({ path, selectors, text, query, basePath }) => {
    const sample: NavigationSample = { start: null, complete: null, pathname: path }
    window.__navigationSample = sample
    document.addEventListener('click', () => {
      sample.start = performance.now()
      let readyFrames = 0
      function check() {
        const elements = selectors.map(selector => document.querySelector<HTMLElement>(selector))
        const pathWithoutBase = basePath && (location.pathname === basePath || location.pathname.startsWith(`${basePath}/`))
          ? location.pathname.slice(basePath.length) || '/'
          : location.pathname
        const currentPath = pathWithoutBase.replace(/^\/(?:en|zh-CN)(?=\/|$)/, '') || '/'
        const ready = currentPath === path && (!query || location.search.includes(query)) &&
          elements.every(element => element && element.getBoundingClientRect().height > 0 && !element.matches(':disabled')) &&
          (!text || elements.some(element => element?.textContent?.includes(text))) &&
          !document.querySelector('[data-settings-state="loading"], [data-settings-state="error"]')
        readyFrames = ready ? readyFrames + 1 : 0
        if (readyFrames >= 2) sample.complete = performance.now()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }, { once: true, capture: true })
  }, { ...destination, basePath: BASE_PATH })
  const requests: { url: string; status: number; ms: number }[] = []
  const started = Date.now()
  const record = (response: import('@playwright/test').Response) => {
    if (new URL(response.url()).origin !== new URL(page.url()).origin) return
    requests.push({ url: new URL(response.url()).pathname, status: response.status(), ms: Date.now() - started })
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
const teams: Destination = { path: '/settings/teams', selectors: ['[data-settings-state="ready"]', 'input[aria-label="搜索团队"]'], text: '创建第一个团队' }
const preferences: Destination = { path: '/settings', query: 'section=preferences', selectors: ['main [aria-label="界面主题"]', 'main button[aria-label="浅色"]'] }
const profile: Destination = { path: '/settings', query: 'section=account', selectors: ['main section[aria-labelledby="account-heading"]'], text: '回归测试成员' }
const workspace: Destination = { path: '/settings', query: 'section=general', selectors: ['main section[aria-label="工作区基本信息"]', '#workspace-name', '#workspace-id'] }

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const first of ['成员', '团队'] as const) {
    test(`首访${first}、设置互切与缓存返回均不超过 1 秒 (${viewport.width}px)`, { tag: '@performance' }, async ({ page }, info) => {
      await page.setViewportSize(viewport)
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
        for (const [name, destination] of [['账户', profile], ['成员', members], ['团队', teams], ['常规', workspace], ['偏好设置', preferences]] as const) {
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
      const memberLink = await sidebarLink('成员')
      await measureNavigation(page, info, '成员可操作', members, () => memberLink.click())
      await page.getByRole('textbox', { name: '搜索成员或邀请', exact: true }).fill('不匹配的搜索词')
      await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toHaveCount(0)
    })
  }
}
