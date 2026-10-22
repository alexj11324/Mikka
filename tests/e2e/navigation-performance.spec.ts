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

const budgetMs = 1000

type Destination = { path: string; selectors: string[]; text?: string }
type NavigationSample = { start: number | null; complete: number | null; pathname: string }
declare global { interface Window { __navigationSample?: NavigationSample } }

// 从真实点击开始计时，直到目标数据内容连续两帧可见且可操作；标题、URL 或骨架屏不算完成。
async function measureNavigation(page: Page, info: TestInfo, name: string, destination: Destination, navigate: () => Promise<unknown>) {
  await page.evaluate(({ path, selectors, text, basePath }) => {
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
        const ready = currentPath === path &&
          elements.every(element => element && element.getBoundingClientRect().height > 0 && !element.matches(':disabled')) &&
          (!text || elements.some(element => element?.textContent?.includes(text)))
        readyFrames = ready ? readyFrames + 1 : 0
        if (readyFrames >= 2) sample.complete = performance.now()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }, { once: true, capture: true })
  }, { ...destination, basePath: BASE_PATH })
  const requests: { url: string; status: number; ms: number }[] = []
  const started = Date.now()
  const record = (response: { url(): string; status(): number }) => { requests.push({ url: response.url(), status: response.status(), ms: Date.now() - started }) }
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

const preferences: Destination = { path: '/', selectors: ['main [aria-label="界面主题"]', 'main button[aria-label="浅色"]'] }
const profile: Destination = { path: '/', selectors: ['main section[aria-labelledby="profile-heading"]'], text: '回归测试成员' }
const workspace: Destination = { path: '/', selectors: ['main section[aria-label="工作区基本信息"]', '#workspace-name', '#workspace-id'] }
const members: Destination = { path: '/', selectors: ['input[aria-label="搜索成员或邀请"]', 'main table tbody'], text: '回归测试成员' }

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`进入设置、设置分区互切与成员页均不超过 1 秒 (${viewport.width}px)`, { tag: '@performance' }, async ({ page }, info) => {
    const mobile = viewport.width < 768
    await page.setViewportSize(viewport)
    // 不等待预取、networkidle 或固定休眠；注册后即可按用户路径点击。
    await register(page)
    async function openSidebar() {
      if (!mobile) return page.locator('[data-slot="sidebar-container"]')
      const dialog = page.getByRole('dialog')
      // 从账户菜单进入设置时移动端侧栏仍保持打开，直接复用。
      if (!await dialog.isVisible()) await page.getByRole('button', { name: '展开或收起侧栏', exact: true }).click()
      await expect(dialog).toBeVisible()
      return dialog
    }

    let sidebar = await openSidebar()
    await sidebar.getByRole('button', { name: '账户菜单', exact: true }).click()
    await measureNavigation(page, info, '工作台进入设置', preferences, () => page.getByRole('menuitem', { name: '设置', exact: true }).click())

    for (let round = 1; round <= 3; round++) {
      for (const [name, destination] of [['个人资料', profile], ['工作区', workspace], ['偏好设置', preferences]] as const) {
        sidebar = await openSidebar()
        const section = sidebar.getByRole('button', { name, exact: true })
        await measureNavigation(page, info, `${name}-切换-${round}`, destination, () => section.click())
        if (mobile) await expect(page.getByRole('dialog')).toBeHidden()
      }
    }

    sidebar = await openSidebar()
    await sidebar.getByRole('button', { name: '返回应用', exact: true }).click()
    if (mobile) await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('heading', { level: 1, name: '偏好设置' })).toBeHidden()
    sidebar = await openSidebar()
    await sidebar.getByRole('button', { name: '账户菜单', exact: true }).click()
    await measureNavigation(page, info, '重新进入设置', preferences, () => page.getByRole('menuitem', { name: '设置', exact: true }).click())
    sidebar = await openSidebar()
    const membersButton = sidebar.getByRole('button', { name: '成员', exact: true })
    await measureNavigation(page, info, '设置进入成员管理', members, () => membersButton.click())
    // 真实输入验证内容已水合、可操作，而不是仅服务器 HTML 可见。
    await page.getByRole('textbox', { name: '搜索成员或邀请', exact: true }).fill('不匹配的搜索词')
    await expect(page.getByRole('row').filter({ hasText: '回归测试成员' })).toHaveCount(0)
  })
}
