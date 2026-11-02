import { randomUUID } from 'node:crypto'
import { test, expect, register, registerInTeam, browserClientHeaders, watchRuntime, app, BASE_PATH } from './fixtures'
import { attachLightDark } from './settings-v4-shots'

// V10 常规 and S-I 删除工作区 (Figma 551:7960, 551:9716) against the real backend.
test('管理员可以改名、改地址并删除工作区', async ({ page }, testInfo) => {
  await registerInTeam(page, '/settings?section=general')
  await expect(page.getByRole('heading', { level: 1, name: '常规' })).toBeVisible()
  const name = page.getByRole('textbox', { name: '名称', exact: true })
  const address = page.getByRole('textbox', { name: '地址', exact: true })
  await expect(name).toBeEditable()
  await attachLightDark(page, testInfo, 'general-admin')

  const renamed = `E2E ${randomUUID().slice(0, 6)}`
  await name.fill(renamed)
  await name.press('Enter')
  await expect(name).toHaveValue(renamed)
  const slug = `e2e-${randomUUID().slice(0, 8)}`
  await address.fill(slug)
  // Reload only once the address save has returned; a reload before that cancels it in flight.
  const addressSaved = page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().postData()?.includes(slug)))
  await address.press('Enter')
  await expect(address).toHaveValue(slug)
  await addressSaved
  await page.reload()
  await expect(name).toHaveValue(renamed)
  await expect(address).toHaveValue(slug)

  await address.fill('-bad-')
  await address.press('Enter')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(address).toHaveValue(slug)
  await attachLightDark(page, testInfo, 'general-save-failed')

  await page.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `删除「${renamed}」？` })).toBeVisible()
  await expect(dialog.getByText(/个 Bot、它们的线程和云电脑/)).toBeVisible()
  const confirm = dialog.getByRole('button', { name: '删除工作区', exact: true })
  await expect(confirm).toBeDisabled()
  await attachLightDark(page, testInfo, 'general-delete-dialog')
  await dialog.getByRole('textbox').fill(renamed)
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page).not.toHaveURL(/section=general/)
})

// 转让工作区 (Alex: 常规 fully wired) and S-P: a member reads 常规 as plain values.
test('成员只读常规；所有者把工作区转让给成员后，转让按钮跟着所有者走', async ({ page, browser, baseURL }, testInfo) => {
  await registerInTeam(page, '/settings/members')
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const invite = page.getByRole('dialog', { name: '邀请成员', exact: true })
  const email = `member-${randomUUID()}@example.com`
  await invite.getByLabel('邮箱地址', { exact: true }).fill(email)
  await invite.getByRole('button', { name: '创建邀请链接', exact: true }).click()
  const inviteURL = new URL(await invite.getByLabel(`${email} 的邀请链接`, { exact: true }).inputValue())
  await invite.getByRole('button', { name: '完成', exact: true }).click()

  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const errors = watchRuntime(memberContext)
  try {
    const member = await memberContext.newPage()
    await register(member, inviteURL.pathname.slice(BASE_PATH.length), email)
    await member.getByRole('button', { name: '接受邀请并加入', exact: true }).click()
    await expect(member).toHaveURL(/\/settings\/members\?workspace=/)
    const workspace = new URL(member.url()).searchParams.get('workspace')!
    await member.goto(app(`/settings?section=general&workspace=${workspace}`))
    await expect(member.getByRole('heading', { level: 1, name: '常规' })).toBeVisible()
    await expect(member.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0)
    await expect(member.getByRole('button', { name: '转让', exact: true })).toHaveCount(0)
    await expect(member.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
    await attachLightDark(member, testInfo, 'general-member')

    await page.goto(app(`/settings?section=general&workspace=${workspace}`))
    await page.getByRole('button', { name: '转让', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: '转让', exact: true })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('combobox', { name: '新的所有者', exact: true }).click()
    await page.getByRole('option', { name: new RegExp(email) }).click()
    await attachLightDark(page, testInfo, 'general-transfer-dialog')
    await confirm.click()
    await expect(page.getByRole('status').filter({ hasText: '已转让给 回归测试成员' })).toBeVisible()
    await expect(page.getByRole('button', { name: '转让', exact: true })).toHaveCount(0)
    // The previous owner stays an admin.
    await expect(page.getByRole('textbox', { name: '名称', exact: true })).toBeEditable()

    // The new owner is an admin now and holds the transfer.
    await member.reload()
    await expect(member.getByRole('textbox', { name: '名称', exact: true })).toBeEditable()
    await expect(member.getByRole('button', { name: '转让', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await memberContext.close()
  }
})
