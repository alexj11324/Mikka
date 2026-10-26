import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, seedTask, openSearch, openIssueFromSearch, app } from './fixtures'

// Real app, real routes, real server actions: no request or action is mocked.
// The search cases need #310's GET /api/search and the scope cases need #301's
// preview/confirm actions, so this file passes only on a baseline with both.
// Group fixtures go through the real group API as the signed-in person.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Global search acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test('⌘K finds a task outside the loaded recent list through server search', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await register(page)
  const tag = randomUUID().slice(0, 8)
  const old = `Archived search target ${tag}`
  const oldId = await seedTask(page, old)
  // The page loads the 100 most recently updated tasks; push the target out of them.
  const pool = isolatedPool()
  try {
    await pool.query(`UPDATE issues SET "updatedAt" = now() - interval '30 days' WHERE id = $1`, [oldId])
    for (let index = 0; index < 100; index++) await seedTask(page, `Filler ${tag} ${index}`)
  } finally { await pool.end() }
  await page.reload()

  const search = await openSearch(page)
  const input = search.getByRole('combobox', { name: '全局搜索', exact: true })
  await input.fill(`target ${tag}`)
  const hit = search.getByRole('option').filter({ hasText: old })
  await expect(hit).toBeVisible()
  await expect(search.getByRole('status')).toHaveText(/\d+ 条结果/)
  await input.fill(`nothing-${randomUUID()}`)
  await expect(search.getByText('没有匹配的结果', { exact: true })).toBeVisible()
  await input.fill(`target ${tag}`)
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(search).toBeHidden()
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(old)
  expect(errors).toEqual([])
})

async function share(page: import('@playwright/test').Page, title: string) {
  await openIssueFromSearch(page, title)
  // An explicit choice to share needs no confirmation.
  await page.getByRole('button', { name: '归属：个人', exact: true }).click()
  await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()
}
async function askPersonal(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '归属：工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '个人', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '改为个人任务？', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('moving a shared task back to personal warns first, then confirms against the preview', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await register(page)
  const title = `Scope dialog ${randomUUID().slice(0, 8)}`
  await seedTask(page, title)
  await page.reload()
  await share(page, title)

  const dialog = await askPersonal(page)
  await expect(dialog).toContainText('已同步到 Linear 的副本可能仍对团队可见')
  await expect(dialog).toContainText('归档不等于隐私擦除')
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()

  await askPersonal(page)
  const confirm = dialog.getByRole('button', { name: '改为个人', exact: true })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '归属：个人', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('an unresolved Linear sync keeps a shared task from becoming personal even after the warning', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await register(page)
  const title = `Scope blocked ${randomUUID().slice(0, 8)}`
  const id = await seedTask(page, title)
  await page.reload()
  await share(page, title)
  // Synthetic fixture: a failed job may already have reached Linear.
  const pool = isolatedPool()
  try { await pool.query(`INSERT INTO linear_sync_outbox (id, "issueId", status) VALUES ($1, $2, 'failed')`, [randomUUID(), id]) }
  finally { await pool.end() }

  const dialog = await askPersonal(page)
  await expect(dialog.getByRole('alert')).toContainText('暂时不能改为个人')
  await expect(dialog.getByRole('button', { name: '改为个人', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a group chat found in ⌘K opens and reads its real messages', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await register(page)
  const workspaceId = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string
  const title = `Search group ${randomUUID().slice(0, 8)}`
  // Created and written through the real group API as the signed-in person.
  const headers = { origin: new URL(page.url()).origin }
  const created = await page.request.post(app('/api/conversations'), { headers, data: { workspaceId, title } })
  expect(created.status()).toBe(201)
  const { id } = await created.json() as { id: string }
  for (const body of ['First note in the group', 'Second note in the group']) {
    expect((await page.request.post(app(`/api/conversations/${id}/messages`), { headers, data: { body } })).status()).toBe(201)
  }
  await page.reload()

  const search = await openSearch(page)
  await search.getByRole('combobox', { name: '全局搜索', exact: true }).fill(title)
  const hit = search.getByRole('option').filter({ hasText: title })
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(search).toBeHidden()
  const chat = page.getByRole('region', { name: title, exact: true })
  await expect(chat).toBeVisible()
  const messages = chat.getByRole('list', { name: '群聊消息', exact: true })
  await expect(messages.getByText('First note in the group', { exact: true })).toBeVisible()
  await expect(messages.getByText('Second note in the group', { exact: true })).toBeVisible()
  await expect(chat.getByRole('status')).toHaveText('群聊暂时只能阅读，发送消息还没有开放。')
  await expect(chat.getByRole('textbox')).toHaveCount(0)
  expect(errors).toEqual([])
})
