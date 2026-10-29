import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, seedTask, openSearch, openIssueFromSearch, app } from './fixtures'

// Real app, real routes, real server actions: no request or action is mocked.
// Scope promotion requires an explicitly saved team choice; returning to personal
// scope is immediate unless a possibly published Linear copy needs reconciliation.
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
  await expect(search.getByRole('listbox').getByText('没有匹配的结果', { exact: true })).toBeVisible()
  await expect(search.getByRole('status')).toHaveText('没有匹配的结果')
  await input.fill(`target ${tag}`)
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(search).toBeHidden()
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(old)
  expect(errors).toEqual([])
})

async function prepareTeam(page: import('@playwright/test').Page) {
  await register(page, '/settings/teams')
  await page.getByRole('button', { name: '新建团队', exact: true }).first().click()
  const form = page.getByRole('form', { name: '创建新团队', exact: true })
  await form.getByLabel('团队名称', { exact: true }).fill('范围测试团队')
  await form.getByLabel('团队标识', { exact: true }).fill('SCOPE')
  await form.getByRole('button', { name: '创建团队', exact: true }).click()
  await expect(page.getByRole('heading', { name: '范围测试团队', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回工作台', exact: true }).click()
}

async function share(page: import('@playwright/test').Page, title: string) {
  await openIssueFromSearch(page, title)
  await page.getByRole('combobox', { name: '团队', exact: true }).click()
  await page.getByRole('option', { name: 'SCOPE · 范围测试团队', exact: true }).click()
  const save = page.getByRole('button', { name: '保存团队归属', exact: true })
  await save.click()
  await expect(save).toHaveCount(0)
  // An explicit choice to share needs no confirmation.
  await page.getByRole('button', { name: '归属：个人', exact: true }).click()
  await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()
}
async function choosePersonal(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '归属：工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '个人', exact: true }).click()
}

test('explicit local scope changes do not ask for a second confirmation', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await prepareTeam(page)
  const title = `Scope local ${randomUUID().slice(0, 8)}`
  await seedTask(page, title)
  await page.reload()
  await share(page, title)

  await choosePersonal(page)
  await expect(page.getByRole('button', { name: '归属：个人', exact: true })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('an unresolved Linear publication keeps a shared task from becoming personal', async ({ page, context }) => {
  const errors = watchRuntime(context)
  await prepareTeam(page)
  const title = `Scope blocked ${randomUUID().slice(0, 8)}`
  const id = await seedTask(page, title)
  await page.reload()
  await share(page, title)
  // A Mikka team promotion does not authorize a new Linear publication. The
  // current trigger must still refuse to enqueue this unverified destination.
  const pool = isolatedPool()
  try {
    const unverifiedJob = await pool.query(`INSERT INTO linear_sync_outbox (id, "issueId", status) VALUES ($1, $2, 'failed') RETURNING id`, [randomUUID(), id])
    expect(unverifiedJob.rowCount).toBe(0)
    const before = (await pool.query('SELECT scope, revision, "scopeVersion", "linearSyncBlocked" FROM issues WHERE id=$1', [id])).rows[0]
    expect(before).toMatchObject({ scope: 'workspace', linearSyncBlocked: true })

    // Synthetic retained state: an earlier reservation committed but its
    // provider response was lost. There is no active link or provider grant.
    // Preserve the real owner/generation and all current database guards.
    const syncId = randomUUID(), publicationId = randomUUID(), remoteId = randomUUID()
    const sync = await pool.query(`INSERT INTO linear_team_syncs (id, "ownerId", "linearTeamId", "linearTeamKey", "linearTeamName", active)
      SELECT $1, "userId", $2, 'SCOPE', 'Synthetic retained Linear target', false FROM issues WHERE id=$3 RETURNING id`, [syncId, randomUUID(), id])
    expect(sync.rowCount).toBe(1)
    const publication = await pool.query(`INSERT INTO linear_issue_publications (id, "issueId", "ownerId", "teamSyncId", "scopeVersion", "linearIssueId", "writePending")
      SELECT $1, id, "userId", $2, "scopeVersion", $3, true FROM issues WHERE id=$4 RETURNING *`, [publicationId, syncId, remoteId, id])
    expect(publication.rowCount).toBe(1)
    expect((await pool.query('SELECT id FROM linear_issue_links WHERE "issueId"=$1', [id])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM linear_sync_outbox WHERE "issueId"=$1', [id])).rowCount).toBe(0)

    await choosePersonal(page)
    await expect(page.getByText('请先确认如何处理 Linear 中的任务，再转为个人任务。', { exact: true })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '归属：工作区', exact: true })).toBeVisible()
    expect((await pool.query('SELECT scope, revision, "scopeVersion", "linearSyncBlocked" FROM issues WHERE id=$1', [id])).rows[0]).toEqual(before)
    expect((await pool.query('SELECT * FROM linear_issue_publications WHERE id=$1', [publicationId])).rows).toEqual(publication.rows)
  } finally { await pool.end() }
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
