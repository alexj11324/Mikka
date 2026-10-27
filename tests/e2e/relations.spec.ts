import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register, rail, seedTask, openIssueFromSearch } from './fixtures'

/** The relation pickers' server-side search (GET /api/issues/search). */
const SEARCH = /\/api\/issues\/search\?/

async function openIssue(page: Page, title: string) {
  await openIssueFromSearch(page, title)
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
  await expect(page.getByRole('button', { name: '更多任务操作', exact: true })).toBeEnabled()
}

async function properties(page: Page) {
  await expect(page.getByRole('button', { name: '更多任务操作', exact: true })).toBeEnabled()
  const toggle = page.getByRole('button', { name: '属性与任务关系', exact: true })
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
}

async function chooseRelation(page: Page, title: string, target: string, nested = false) {
  await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
  if (nested) await page.getByRole('menuitem', { name: '添加任务关系', exact: true }).click()
  await page.getByRole('menuitem', { name: `${title}…`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.getByRole('combobox', { name: '搜索关联任务', exact: true }).fill(target)
  await dialog.getByRole('option').filter({ hasText: target }).click()
  return dialog
}

for (const viewport of [{ width: 402, height: 874 }, { width: 1280, height: 900 }]) {
  test(`子任务与阻塞关系的创建、循环校验、解除和刷新持久化 ${viewport.width}`, async ({ page }) => {
    test.setTimeout(180000)
    await register(page)
    const suffix = randomUUID().slice(0, 8)
    const parent = `关系父任务 ${suffix}`
    const child = `关系子任务 ${suffix}`
    const blocker = `前置阻塞任务 ${suffix}`
    await seedTask(page, parent)
    await seedTask(page, blocker)
    await page.reload()
    await rail(page, '看板').click()
    await openIssue(page, parent)
    const parentUrl = page.url()
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: 'dark' })

    await page.getByRole('button', { name: '创建子任务', exact: true }).click()
    const create = page.getByRole('dialog', { name: '创建子任务', exact: true })
    await create.getByRole('textbox', { name: '任务标题', exact: true }).fill(child)
    await create.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(create).not.toBeVisible()
    const children = page.getByRole('region', { name: '子任务', exact: true })
    await expect(children.getByRole('button', { name: '子任务 0 / 1', exact: true })).toBeVisible()
    await children.getByRole('button', { name: `${child} 的状态：待办`, exact: true }).click()
    await page.getByRole('menuitem', { name: '已完成', exact: true }).click()
    await expect(children.getByRole('button', { name: '子任务 1 / 1', exact: true })).toBeVisible()
    await page.reload()
    await expect(children.getByRole('button', { name: '子任务 1 / 1', exact: true })).toBeVisible()

    // The parent picker hides this task's descendants (the server still rejects parent cycles with issueParentCycle),
    // so searching for the child yields the query-specific CommandEmpty state.
    await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置父任务…', exact: true }).click()
    const parentPicker = page.getByRole('dialog', { name: '设置父任务', exact: true })
    await expect(parentPicker.getByRole('option').filter({ hasText: blocker })).toBeVisible()
    await parentPicker.getByRole('combobox', { name: '搜索关联任务', exact: true }).fill(child)
    await expect(parentPicker.getByText('没有匹配的任务', { exact: true })).toBeVisible()
    await expect(parentPicker.getByRole('option')).toHaveCount(0)
    await parentPicker.getByRole('button', { name: '关闭', exact: true }).click()
    await children.getByRole('button', { name: `移除子任务关系：${child}`, exact: true }).click()
    await expect(children.getByRole('button', { name: '子任务 0 / 0', exact: true })).toBeVisible()
    // Regression: reopening the picker right after unlinking must not show results from before the unlink
    // (where the child still had this parent). Hold the search request so we observe the picker before fresh data arrives.
    let releaseActions!: () => void
    const actionsHeld = new Promise<void>(resolve => { releaseActions = resolve })
    let heldActions = 0
    await page.route(SEARCH, async route => { heldActions++; await actionsHeld; await route.fallback() })
    await children.getByRole('button', { name: '添加现有任务', exact: true }).click()
    const existing = page.getByRole('dialog', { name: '添加现有子任务', exact: true })
    await expect.poll(() => heldActions).toBeGreaterThan(0)
    await expect(existing.getByText('正在读取任务…', { exact: true }).or(existing.getByRole('option').filter({ hasText: child }))).toBeVisible()
    releaseActions()
    await page.unroute(SEARCH)
    await expect(existing.getByRole('option').filter({ hasText: child })).toBeVisible()
    await existing.getByRole('combobox', { name: '搜索关联任务', exact: true }).fill(child)
    await existing.getByRole('option').filter({ hasText: child }).click()
    await expect(existing).not.toBeVisible()
    await expect(children.getByRole('button', { name: '子任务 1 / 1', exact: true })).toBeVisible()

    await children.getByRole('button').filter({ hasText: child }).filter({ hasNotText: '状态' }).click()
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(child)
    await properties(page)
    const parentSection = page.getByRole('region', { name: '父任务', exact: true })
    await expect(parentSection.getByRole('button').filter({ hasText: parent })).toBeVisible()
    await parentSection.getByRole('button').filter({ hasText: parent }).click()
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(parent)
    await properties(page)
    await page.getByRole('button', { name: '任务优先级：中', exact: true }).click()
    await page.getByRole('menuitem', { name: '高', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: /^已自动保存$/ })).toBeVisible()
    await page.reload()
    await properties(page)
    await expect(page.getByRole('button', { name: '任务优先级：高', exact: true })).toBeVisible()

    const blocked = await chooseRelation(page, '被以下任务阻塞', blocker, true)
    await expect(blocked).not.toBeVisible()
    await properties(page)
    const blockedBy = page.getByRole('region', { name: '被阻塞于', exact: true })
    await expect(blockedBy.getByRole('button').filter({ hasText: blocker })).toBeVisible()
    await page.reload()
    await properties(page)
    await expect(blockedBy.getByRole('button').filter({ hasText: blocker })).toBeVisible()
    await blockedBy.getByRole('button').filter({ hasText: blocker }).click()
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(blocker)
    await properties(page)
    const blocks = page.getByRole('region', { name: '正在阻塞', exact: true })
    await expect(blocks.getByRole('button').filter({ hasText: parent })).toBeVisible()

    const cycle = await chooseRelation(page, '被以下任务阻塞', parent, true)
    await expect(cycle.getByRole('alert')).toHaveText('阻塞关系不能形成循环依赖。')
    await cycle.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '任务状态：待办', exact: true }).click()
    await page.getByRole('menuitem', { name: '已完成', exact: true }).click()
    await expect(blocks).not.toBeVisible()
    const related = page.getByRole('region', { name: '关联任务', exact: true })
    await related.getByRole('button').filter({ hasText: parent }).click()
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(parent)
    await properties(page)
    await expect(blockedBy).not.toBeVisible()
    await expect(related.getByRole('button').filter({ hasText: blocker })).toBeVisible()
    await related.getByRole('button', { name: `移除关联任务：${blocker}`, exact: true }).click()
    await expect(related).not.toBeVisible()
    await page.goto(parentUrl)
    await properties(page)
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(parent)
    await expect(blockedBy).not.toBeVisible()
    await expect(related).not.toBeVisible()
    await expect(children.getByRole('button', { name: '子任务 1 / 1', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test(`关系选择器读取失败时显示错误和重新读取 ${viewport.width}`, async ({ page }) => {
    test.setTimeout(120000)
    await register(page)
    const suffix = randomUUID().slice(0, 8)
    const current = `读取失败当前任务 ${suffix}`
    const target = `读取失败目标任务 ${suffix}`
    await seedTask(page, current)
    await seedTask(page, target)
    await page.reload()
    await rail(page, '看板').click()
    await openIssue(page, current)
    await page.setViewportSize(viewport)
    // Start from an empty SWR cache so the picker has no stale board to fall back on.
    await page.reload()
    await expect(page.getByRole('button', { name: '更多任务操作', exact: true })).toBeEnabled()

    // Fail the picker's search request. A non-JSON 200 body makes the read reject
    // without a browser 'Failed to load resource' console error, which the runtime guard would flag.
    let failing = true
    await page.route(SEARCH, route => failing ? route.fulfill({ status: 200, contentType: 'text/plain', body: 'mocked failure' }) : route.fallback())
    await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置父任务…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '设置父任务', exact: true })
    await expect(picker.getByRole('alert').filter({ hasText: '任务读取失败' })).toBeVisible()
    // The alert sits outside the Command list; the reload option stays in the list.
    await expect(picker.getByRole('listbox').getByText('任务读取失败', { exact: true })).toHaveCount(0)
    const reload = picker.getByRole('option', { name: '重新读取任务', exact: true })
    await expect(reload).toBeVisible()

    failing = false
    await reload.click()
    await expect(picker.getByRole('option').filter({ hasText: target })).toBeVisible()
    await expect(picker.getByRole('alert').filter({ hasText: '任务读取失败' })).toHaveCount(0)
    await expect(reload).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('关系选择器在服务端搜索：编号和标题片段都能找到，父任务选择器不提供后代任务，选中后建立关系', async ({ page }) => {
  test.setTimeout(120000)
  await register(page)
  const suffix = randomUUID().slice(0, 8)
  const current = `搜索当前任务 ${suffix}`
  const target = `搜索目标任务 ${suffix}`
  const child = `搜索子任务 ${suffix}`
  const grandchild = `搜索孙任务 ${suffix}`
  const currentId = await seedTask(page, current)
  await seedTask(page, target)
  const childId = await seedTask(page, child, { parentId: currentId })
  await seedTask(page, grandchild, { parentId: childId })
  await page.reload()
  await rail(page, '看板').click()
  await openIssue(page, current)

  // Parent picker: the server leaves out the task's descendants at every depth.
  await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置父任务…', exact: true }).click()
  const parentPicker = page.getByRole('dialog', { name: '设置父任务', exact: true })
  const parentSearch = parentPicker.getByRole('combobox', { name: '搜索关联任务', exact: true })
  await expect(parentPicker.getByRole('option').filter({ hasText: target })).toBeVisible()
  await expect(parentPicker.getByRole('option').filter({ hasText: suffix })).toHaveCount(1)
  for (const descendant of [child, grandchild]) {
    await parentSearch.fill(descendant)
    await expect(parentPicker.getByText('没有匹配的任务', { exact: true })).toBeVisible()
    await expect(parentPicker.getByRole('option')).toHaveCount(0)
  }
  await parentPicker.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(parentPicker).toHaveCount(0)

  await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加任务关系', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加关联任务…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '添加关联任务', exact: true })
  const search = picker.getByRole('combobox', { name: '搜索关联任务', exact: true })
  const option = picker.getByRole('option').filter({ hasText: target })
  const identifier = (await option.locator('span').first().innerText()).trim()
  const number = /(\d+)$/.exec(identifier)?.[1]
  expect(number).toBeTruthy()
  // A title fragment, the displayed identifier and the bare number each find exactly the target.
  for (const query of [`目标任务 ${suffix}`, identifier, number!]) {
    await search.fill(query)
    await expect(picker.getByRole('option')).toHaveCount(1)
    await expect(option).toBeVisible()
  }
  // One Latin letter is too short for the server; the picker keeps showing recent tasks instead of an error.
  await search.fill('x')
  await expect(option).toBeVisible()
  await expect(picker.getByRole('alert')).toHaveCount(0)
  await search.fill(number!)
  await expect(picker.getByRole('option')).toHaveCount(1)
  await option.click()
  await expect(picker).not.toBeVisible()
  await properties(page)
  const related = page.getByRole('region', { name: '关联任务', exact: true })
  await expect(related.getByRole('button').filter({ hasText: target })).toBeVisible()
  await page.reload()
  await properties(page)
  await expect(related.getByRole('button').filter({ hasText: target })).toBeVisible()
})

test('402x400 短视口：关系选择器标题和关闭按钮不被裁切，列表在内部滚动，状态高度不跳', async ({ page }) => {
  test.setTimeout(120000)
  await register(page)
  const suffix = randomUUID().slice(0, 8)
  const current = `短视口当前任务 ${suffix}`
  await seedTask(page, current)
  for (let i = 0; i < 8; i++) await seedTask(page, `短视口候选 ${i} ${suffix}`)
  await page.reload()
  await rail(page, '看板').click()
  await openIssue(page, current)
  await page.setViewportSize({ width: 402, height: 400 })
  // Hold the picker's reads so the loading state is visible: its text is muted via an inner span, CommandEmpty keeps its default color.
  let releaseReads!: () => void
  const readsHeld = new Promise<void>(resolve => { releaseReads = resolve })
  let holding = true
  await page.route(SEARCH, async route => {
    if (holding) await readsHeld
    return route.fallback()
  })
  await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置父任务…', exact: true }).click()
  const loading = page.getByRole('dialog', { name: '设置父任务', exact: true }).locator('[cmdk-empty]')
  await expect(loading.getByText('正在读取任务…', { exact: true })).toHaveClass(/text-muted-foreground/)
  await expect(loading).not.toHaveClass(/text-muted-foreground/)
  holding = false
  releaseReads()
  await page.unroute(SEARCH)
  // The dialog opens only after the menu has closed (no menu ghosting over it).
  const picker = page.getByRole('dialog', { name: '设置父任务', exact: true })
  await expect(picker).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(picker.getByRole('option').filter({ hasText: `短视口候选 7 ${suffix}` })).toBeVisible()
  const inViewport = async (box: { y: number; height: number } | null) => { expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(400) }
  await inViewport(await picker.boundingBox())
  await inViewport(await picker.getByRole('heading', { name: '设置父任务', exact: true }).boundingBox())
  await inViewport(await picker.locator('[data-slot="dialog-close"]').first().boundingBox())
  const list = picker.locator('[data-slot="command-list"]')
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto')).toBe(true)
  const listHeight = (await list.boundingBox())!.height
  // Empty state keeps the list's minimum height instead of collapsing.
  await picker.getByRole('combobox', { name: '搜索关联任务', exact: true }).fill(`不存在 ${suffix}`)
  await expect(picker.getByText('没有匹配的任务', { exact: false })).toBeVisible()
  expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(Math.min(listHeight, 144) - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // Closing the picker and dismissing a reopened menu without picking must not reopen a previously queued picker.
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await page.getByRole('button', { name: '更多任务操作', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
