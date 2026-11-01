import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { Pool } from 'pg'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'
import { dbUrl, seedAgent, seedRun } from '../support/workspace-admin-db'
import { test as pooledTest } from './test-account-fixtures'
import { test, expect, register, app } from './fixtures'

/**
 * D12: the display name was a read-only span. It is an input that saves in
 * place and survives a reload.
 */
test('个人资料名称可以编辑，保存后刷新仍然生效', { tag: '@smoke' }, async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const sidebar = page.locator('[data-slot="settings-list"]')
  await sidebar.getByRole('link', { name: '账户', exact: true }).click()

  const name = page.getByRole('textbox', { name: '名称', exact: true })
  await expect(name).toHaveValue('回归测试成员')
  await name.fill('新的显示名')
  // Saves on Enter or when the field is left, like the workspace name; there is no 保存 button.
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  await name.press('Enter')
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  await page.reload()
  await page.locator('[data-slot="settings-list"]').getByRole('link', { name: '账户', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('新的显示名')
})

// D14: the language row was a span. Choosing English switches the interface.
test('切换界面语言后进入英文界面', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('group', { name: '界面语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click()
  await expect(page).toHaveURL(/\/en\//)
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
})

// D16: the web Settings page now has the notification settings the phone has.
test('通知设置可以关闭主动消息，刷新后保持', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const sidebar = () => page.locator('[data-slot="settings-list"]')
  await sidebar().getByRole('link', { name: '通知', exact: true }).click()

  const proactive = page.getByRole('switch', { name: '主动消息', exact: true })
  await expect(proactive).toBeChecked()
  await proactive.click()
  await expect(proactive).not.toBeChecked()

  await page.reload()
  await sidebar().getByRole('link', { name: '通知', exact: true }).click()
  await expect(page.getByRole('switch', { name: '主动消息', exact: true })).not.toBeChecked()
})

// S-O: a refused save puts the switch back and offers a retry that sends the same change.
test.describe('通知保存失败', () => {
  // The test aborts the save itself; Chromium logs that aborted server-action POST once.
  // Only that save is aborted: Settings also prefetches other sections' data through server actions while idle.
  test.use({ expectedConsoleErrors: [{ path: '/mikka/settings?section=notifications', message: 'Failed to load resource: net::ERR_FAILED' }] })

test('通知保存失败时开关恢复原值，重试后保存成功', async ({ page }) => {
  await register(page, '/settings?section=notifications')
  const proactive = page.getByRole('switch', { name: '主动消息', exact: true })
  await expect(proactive).toBeChecked()
  // A server action POSTs its arguments as JSON with a Next-Action header; drop exactly the save of this switch.
  let aborted = 0
  const dropSave = async (route: import('@playwright/test').Route) => {
    const request = route.request()
    let args: unknown
    try { args = request.headers()['next-action'] ? JSON.parse(request.postData() ?? '') : undefined } catch { args = undefined }
    if (JSON.stringify(args) !== JSON.stringify([{ proactive: false }])) return route.fallback()
    aborted += 1
    return route.abort()
  }
  await page.route('**/*', dropSave)
  await proactive.click()
  await expect(page.locator('[data-slot="alert"]')).toContainText('这项设置没有保存，已恢复为原来的值。')
  await expect(proactive).toBeChecked()
  expect(aborted).toBe(1)
  await page.unroute('**/*', dropSave)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.locator('[data-slot="alert"]')).toHaveCount(0)
  await expect(proactive).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: '主动消息', exact: true })).not.toBeChecked()
})
})

// D14 follow-up: switching language keeps the section and the workspace in the URL.
test('切换界面语言后停留在同一个设置分区', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  await page.getByRole('group', { name: '界面语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click()
  await expect(page).toHaveURL(/\/en\/settings\?.*section=preferences/)
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
})

// File payloads are explicit nonproduction backend fixtures; the leased browser
// exercises real settings actions, cookie authentication, streaming and expiry.
pooledTest('account export downloads owned file versions, captures and checkpoints while denying peer and expired grants', async ({ page, testAccounts }) => {
  if (!dbUrl) throw new Error('Portable account export requires the isolated browser database')
  if (process.env.RESEND_API_KEY) throw new Error('Portable account acceptance does not send provider mail')
  const database = new Pool({ connectionString: dbUrl, max: 2 })
  const owner = testAccounts.scope.owner.userId, peer = testAccounts.scope.peer.userId
  await testAccounts.scope.assertActive()
  const priorExportIds = (await database.query<{ id: string }>('SELECT id FROM account_data_exports WHERE "userId"=$1', [owner])).rows.map(row => row.id)
  const agentId = await seedAgent(database, owner), runId = await seedRun(database, { userId: owner, agentId })
  const ownArtifact = randomUUID(), peerArtifact = randomUUID(), firstVersion = randomUUID(), secondVersion = randomUUID(), captureId = randomUUID()
  const first = Buffer.from('first owned version — 原文'), second = Buffer.from('second owned version 😀'), capture = Buffer.from([137, 80, 78, 71, 0, 255, 17])
  const patch = gzipSync('diff --git a/note b/note\n+owned checkpoint\n')
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  try {
    await database.query('INSERT INTO artifacts(id,"userId",kind,title,"latestVersion") VALUES($1,$3,\'markdown\',\'Portable document\',2),($2,$4,\'markdown\',\'Peer private document\',1)', [ownArtifact, peerArtifact, owner, peer])
    for (const [id, artifactId, version, bytes] of [[firstVersion, ownArtifact, 1, first], [secondVersion, ownArtifact, 2, second], [randomUUID(), peerArtifact, 1, Buffer.from('peer private content')]] as const) {
      await database.query('INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,$3,$4,$5,$6,$7,\'Browser fixture\')', [id, artifactId, version, `browser-export/${id}`, bytes.toString('utf8'), digest(bytes), bytes.length])
    }
    await database.query('INSERT INTO run_captures(id,"userId","runId",kind,"contentType",source,status,title,"inlineContent",sha256,size,"storageKey") VALUES($1,$2,$3,\'image\',\'image/png\',\'local\',\'ready\',\'Portable capture\',$4,$5,$6,$7)', [captureId, owner, runId, capture, digest(capture), capture.length, `browser-export/${captureId}`])
    await database.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt") VALUES($1,$2,$3,$4,1,now())', [runId, owner, 'a'.repeat(40), patch])
    await page.goto(app('/settings?section=privacy'))
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const link = page.getByRole('link', { name: '下载导出文件', exact: true })
    await expect(link).toBeVisible()
    const href = await link.getAttribute('href'); expect(Boolean(href)).toBe(true)
    const token = new URL(href!, page.url()).pathname.split('/').at(-1)!
    await recordAuthenticationSecrets([token])
    const downloadPromise = page.waitForEvent('download')
    await link.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^mikka-export-\d{4}-\d{2}-\d{2}\.json$/)
    const path = await download.path(); expect(Boolean(path)).toBe(true)
    const data = JSON.parse(await readFile(path!, 'utf8'))
    expect(data.format).toBe('mikka-account-export')
    expect(data.profile.id).toBe(owner)
    expect(data.fileManifest.complete).toBe(true)
    const bytes = (id: string) => Buffer.from(data.files.find((file: { id: string }) => file.id === id).content, 'base64')
    expect(bytes(firstVersion).equals(first)).toBe(true); expect(bytes(secondVersion).equals(second)).toBe(true)
    expect(bytes(captureId).equals(capture)).toBe(true); expect(bytes(runId).equals(patch)).toBe(true)
    expect(data.files.some((file: { artifactId?: string }) => file.artifactId === peerArtifact)).toBe(false)
    const denied = await testAccounts.scope.peer.request(href!)
    expect(denied.status).toBe(404)
    await database.query('UPDATE account_data_exports SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1 AND "tokenHash"=$2', [owner, createHash('sha256').update(token).digest('hex')])
    const expired = await testAccounts.scope.owner.request(href!)
    expect(expired.status).toBe(404)
  } finally {
    try {
      await testAccounts.scope.assertActive()
      // The exclusive lease identifies grants created by this case, including a
      // failed UI request before its token is captured. Preserve all prior grants.
      const createdExportIds = (await database.query<{ id: string }>('SELECT id FROM account_data_exports WHERE "userId"=$1 AND NOT (id=ANY($2::uuid[]))', [owner, priorExportIds])).rows.map(row => row.id)
      await database.query('DELETE FROM account_data_exports WHERE "userId"=$1 AND id=ANY($2::uuid[])', [owner, createdExportIds])
      await database.query('DELETE FROM artifacts WHERE id=ANY($1::uuid[])', [[ownArtifact, peerArtifact]])
      await database.query('DELETE FROM agent_runs WHERE id=$1', [runId])
      await database.query('DELETE FROM agents WHERE id=$1', [agentId])
    } finally { await database.end() }
  }
})
