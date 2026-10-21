import { expect, type Locator, type Page } from '@playwright/test'

export const controlsSelector = ':is(button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="combobox"], input[type="checkbox"], input[type="radio"]):visible'

export async function visibleState(page: Page) {
  const snapshot = await page.locator('body').ariaSnapshot()
  let tooltipIndent = -1
  return snapshot.split('\n').filter(line => {
    const indent = line.search(/\S/)
    if (/^- tooltip(?: |:)/.test(line.trim())) { tooltipIndent = indent; return false }
    if (tooltipIndent >= 0 && indent > tooltipIndent) return false
    tooltipIndent = -1
    return true
  }).join('\n')
}

export async function clickWithEffect(page: Page, control: Locator) {
  await expect(control).toBeVisible()
  await expect(control).toBeEnabled()
  await control.scrollIntoViewIfNeeded()
  // 先 hover 再取基线，避免 tooltip、焦点或轮询请求让死按钮假通过。
  await control.hover()
  const before = await visibleState(page)
  const url = page.url()
  let nativeDialog = false
  let download = false
  let popup: Page | undefined
  const onDialog = async (dialog: import('@playwright/test').Dialog) => { nativeDialog = true; await dialog.dismiss() }
  const onDownload = () => { download = true }
  const onPopup = (opened: Page) => { popup = opened }
  page.on('dialog', onDialog)
  page.on('download', onDownload)
  page.on('popup', onPopup)
  try {
    await control.click()
    await expect.poll(async () => {
      if (nativeDialog || download || (popup && popup.url() !== 'about:blank')) return true
      if (page.url() !== url) return true
      return await visibleState(page) !== before
    }, { timeout: 4000, message: '点击后必须有 URL、可访问界面、弹窗、下载或系统对话框变化；仅网络请求或 console.log 不算成功。' }).toBe(true)
    return { before, after: await visibleState(page) }
  } finally {
    page.off('dialog', onDialog)
    page.off('download', onDownload)
    page.off('popup', onPopup)
    await popup?.close()
  }
}

export async function inspectControl(control: Locator, page: Page) {
  return control.evaluate((element, currentURL) => {
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim().replace(/\s+/g, ' ') || element.outerHTML.slice(0, 160)
    let skip = ''
    if (element.closest('[inert], [aria-hidden="true"]')) skip = '浮层下的不可交互背景'
    else if (element.matches(':disabled, [aria-disabled="true"]')) skip = '禁用态，不可执行'
    else if (element.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), [data-active]:not([data-active="false"])') || element.querySelector('[aria-label="已选中"]')) skip = '当前已选项，允许幂等'
    else if (element.getAttribute('aria-pressed') === 'true' && element.closest('[data-slot="toggle-group"]')) skip = '当前视图，允许幂等'
    else if (element.matches('button[type="submit"], input[type="submit"]')) skip = '提交由 workspace.spec.ts 和 members.spec.ts 业务断言覆盖'
    else if (label === '退出登录') skip = '退出由 workspace.spec.ts 覆盖，避免撤销后续测试会话'
    const href = element.getAttribute('href')
    if (!skip && href !== null && ['', '#'].includes(href.trim())) throw new Error(`占位链接不可点击：${label}`)
    if (!skip && href) {
      const target = new URL(href, currentURL)
      if (target.origin !== new URL(currentURL).origin) skip = '外部文档链接，不在通用业务点击测试中访问第三方'
      else if (target.href === currentURL) skip = '当前页面链接，允许幂等'
    }
    return { label, skip }
  }, page.url())
}
