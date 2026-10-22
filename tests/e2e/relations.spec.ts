import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

async function createIssue(page: Page, title: string) {
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
  await dialog.getByLabel('任务标题', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

async function openIssue(page: Page, title: string) {
  await page.getByRole('button', { name: '打开全局搜索', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '搜索任务', exact: true })
  await dialog.getByRole('combobox', { name: '全局搜索任务', exact: true }).fill(title)
  await dialog.getByRole('option').filter({ hasText: title }).click()
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
    await createIssue(page, parent)
    await createIssue(page, blocker)
    await page.getByRole('button', { name: '任务', exact: true }).click()
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

    const invalidParent = await chooseRelation(page, '设置父任务', child)
    await expect(invalidParent.getByRole('alert')).toHaveText('父子任务不能形成循环。')
    await invalidParent.getByRole('button', { name: '关闭', exact: true }).click()
    await children.getByRole('button', { name: `移除子任务关系：${child}`, exact: true }).click()
    await expect(children.getByRole('button', { name: '子任务 0 / 0', exact: true })).toBeVisible()
    await children.getByRole('button', { name: '添加现有任务', exact: true }).click()
    const existing = page.getByRole('dialog', { name: '添加现有子任务', exact: true })
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
}
