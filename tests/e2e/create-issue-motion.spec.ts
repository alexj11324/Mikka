import { test, expect, register, app } from './fixtures'

// MIK-18: new-issue dialog — empty-title feedback, bounded description, optimistic insert + rollback.
async function openDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('空标题提交显示“请输入标题”，Ctrl+Enter 同样提示并设置 aria-invalid', async ({ page }) => {
  await register(page, '/')
  const dialog = await openDialog(page)
  const title = dialog.getByLabel('任务标题', { exact: true })
  await title.press('Control+Enter')
  await expect(dialog.getByRole('alert').filter({ hasText: '请输入标题' })).toBeVisible()
  await expect(title).toHaveAttribute('aria-invalid', 'true')
  await expect(title).toBeFocused()
  const message = dialog.locator('[data-slot="field-error"]')
  expect(await message.evaluate(el => getComputedStyle(el).animationName)).not.toBe('none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await message.evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(dialog.getByText('请输入标题', { exact: true })).toBeVisible()
  await title.fill('有标题了')
  await expect(dialog.getByText('请输入标题', { exact: true })).toHaveCount(0)
  await expect(title).not.toHaveAttribute('aria-invalid', 'true')
})

test('长描述时编辑区最高 40vh 内部滚动，头部和底部保持可见', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await register(page, '/')
  const dialog = await openDialog(page)
  const editor = dialog.locator('[data-slot="new-issue-description"]')
  await editor.locator('[contenteditable="true"]').click()
  for (let i = 0; i < 60; i++) await page.keyboard.press('Enter')
  const box = await editor.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(800 * 0.4 + 1)
  expect(await editor.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  const dialogBox = (await dialog.boundingBox())!
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(800)
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: '关闭新建任务', exact: true })).toBeInViewport()
})

test.describe('optimistic create', () => {
  // The rollback case aborts the saveIssue server action on purpose; Chromium logs that one failed request.
  test.use({ expectedConsoleErrors: [{ path: app('/'), message: 'Failed to load resource: net::ERR_FAILED' }] })
test('创建时卡片乐观插入；保存失败时回滚并提示', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部任务', exact: true })).toBeVisible()
  const board = page.getByRole('region', { name: '任务看板', exact: true })
  let dialog = await openDialog(page)
  // Hold the save request so the optimistic card is observable before the server answers.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && request.headers()['next-action'] && request.postData()?.includes('乐观任务')) { await held; return route.continue() }
    return route.fallback()
  })
  await dialog.getByLabel('任务标题', { exact: true }).fill('乐观任务')
  await dialog.getByLabel('任务标题', { exact: true }).press('Control+Enter')
  await expect(board.locator('[data-optimistic]').filter({ hasText: '乐观任务' })).toHaveCount(1)
  const card = board.locator('[data-optimistic]')
  expect(await card.evaluate(el => getComputedStyle(el).transitionProperty)).toContain('max-height')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await card.evaluate(el => getComputedStyle(el).transitionProperty)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  release()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-optimistic]')).toHaveCount(0)
  await expect(board.getByText('乐观任务', { exact: true })).toBeVisible()
  await page.unroute('**/*')

  dialog = await openDialog(page)
  await page.route('**/*', route => {
    const request = route.request()
    if (request.method() === 'POST' && request.headers()['next-action'] && request.postData()?.includes('会失败的任务')) return route.abort('failed')
    return route.fallback()
  })
  await dialog.getByLabel('任务标题', { exact: true }).fill('会失败的任务')
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: '暂时无法创建' })).toBeVisible()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '暂时无法创建' })).toBeVisible()
  await expect(page.locator('[data-optimistic]')).toHaveCount(0)
  await expect(board.getByText('会失败的任务', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('任务标题', { exact: true })).toHaveValue('会失败的任务')
  await page.unroute('**/*')
})
})
