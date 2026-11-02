import { test, expect, register, seedSavedLogin, app } from './fixtures'

// Real application, real isolated database, normal allocated account. Saving a
// password needs the credential KMS, which a local server does not have
// (docs/local-runtime.md), so the save here must fail closed and say so; the
// successful save, replace and owner checks run in the database suites
// (lib/credentials/store.db.test.ts, tests/settings-activity.db.test.ts).
test('密钥与登录：在设置里添加、改密码、删除网站登录，不再跳回 Bot', async ({ page }, testInfo) => {
  await register(page, '/settings?section=logins')
  await expect(page.getByRole('heading', { name: '密钥与登录', level: 1 })).toBeVisible()
  const section = page.getByRole('region', { name: '网站登录', exact: true })
  await expect(section.getByText('还没有保存的网站登录。')).toBeVisible()
  await testInfo.attach('logins-empty', { body: await page.screenshot(), contentType: 'image/png' })

  // 添加 opens a sheet in settings; it never links to the Bot chat.
  await expect(section.getByRole('link', { name: /添加/ })).toHaveCount(0)
  await section.getByRole('button', { name: '添加', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: '添加网站登录', exact: true })
  await expect(sheet).toBeVisible()
  await expect(page).toHaveURL(url => url.pathname.endsWith('/settings') && url.searchParams.get('section') === 'logins')
  await expect(sheet.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await sheet.getByLabel('网站', { exact: true }).fill('figma.com')
  await sheet.getByLabel('账号', { exact: true }).fill('fixture@example.com')
  const password = sheet.getByLabel('密码', { exact: true })
  await password.fill('fixture-password')
  await expect(password).toHaveAttribute('type', 'password')
  await sheet.getByRole('button', { name: '显示密码', exact: true }).click()
  await expect(password).toHaveAttribute('type', 'text')
  await expect(sheet.getByText('安全保护')).toBeVisible()
  await testInfo.attach('logins-add-sheet', { body: await page.screenshot(), contentType: 'image/png' })
  await sheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sheet.getByText('网站登录暂时不可用。')).toBeVisible()
  await expect(sheet).toBeVisible()
  await expect(page).toHaveURL(url => url.pathname.endsWith('/settings'))
  await sheet.getByRole('button', { name: '取消', exact: true }).click()
  await expect(sheet).toHaveCount(0)

  // A login the vault already holds: change its password from the ⋯ menu, then delete it.
  await seedSavedLogin(page, 'https://linear.app', 'fixture@example.com')
  await page.goto(app('/settings?section=logins'))
  const row = section.getByRole('listitem').filter({ hasText: 'linear.app' })
  await expect(row).toContainText('fixture@example.com')
  await row.getByRole('button', { name: 'linear.app 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '改密码', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'linear.app', exact: true })
  await expect(edit.getByLabel('网站', { exact: true })).toHaveValue('https://linear.app')
  await expect(edit.getByLabel('网站', { exact: true })).toHaveAttribute('readonly', '')
  await expect(edit.getByLabel('账号', { exact: true })).toHaveAttribute('readonly', '')
  await expect(edit.getByLabel('新密码', { exact: true })).toHaveValue('')
  await expect(edit.getByLabel('新密码', { exact: true })).toBeFocused()
  await testInfo.attach('logins-edit-sheet', { body: await page.screenshot(), contentType: 'image/png' })
  await edit.getByRole('button', { name: '取消', exact: true }).click()

  await row.getByRole('button', { name: 'linear.app 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(section.getByText('还没有保存的网站登录。')).toBeVisible()
})
