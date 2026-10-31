import { test, expect } from './test-account-fixtures'
import { app } from './fixtures'

test('pooled owner and peer keep ordinary browser sessions and workspace isolation', { tag: '@smoke' }, async ({ page, peerPage, testAccounts }, testInfo) => {
  const { scope } = testAccounts
  expect(scope.owner.userId).not.toBe(scope.peer.userId)
  expect(scope.owner.namespace).not.toBe(scope.peer.namespace)

  const ownerResponse = await scope.owner.request(app('/api/workspace'))
  const peerResponse = await scope.peer.request(app('/api/workspace'))
  expect(ownerResponse.status).toBe(200)
  expect(peerResponse.status).toBe(200)
  const ownerWorkspace = await ownerResponse.json()
  const peerWorkspace = await peerResponse.json()
  expect(ownerWorkspace.currentUserId).toBe(scope.owner.userId)
  expect(peerWorkspace.currentUserId).toBe(scope.peer.userId)
  expect(ownerWorkspace.workspace.id).not.toBe(peerWorkspace.workspace.id)
  const denied = await scope.peer.request(app(`/api/workspace?workspace=${encodeURIComponent(ownerWorkspace.workspace.id)}`))
  expect(denied.status).toBe(403)

  const anonymous = await fetch(new URL(app('/api/workspace'), page.url()), { redirect: 'error' })
  expect(anonymous.status).toBe(401)
  await anonymous.body?.cancel()
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
  await expect(peerPage.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
  await testInfo.attach('pooled-owner-workspace', {
    body: await page.screenshot({ mask: [page.locator('input'), page.locator('[data-slot="avatar"]')] }),
    contentType: 'image/png',
  })
})

test('a real browser sign-out revokes the leased session without signing out the peer', async ({ page, peerPage, testAccounts }) => {
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === app('/sign-in') && url.searchParams.get('login') === '1')
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()

  // The runner still has the original issued cookie. Replaying it proves
  // server revocation, rather than merely observing browser cookie removal.
  const revoked = await testAccounts.scope.owner.request(app('/api/auth/get-session'))
  const payload = await revoked.json()
  expect(payload === null).toBe(true)
  const peerResponse = await testAccounts.scope.peer.request(app('/api/auth/get-session'))
  const peerSession = await peerResponse.json()
  expect(peerSession?.user?.id).toBe(testAccounts.scope.peer.userId)
  await peerPage.reload()
  await expect(peerPage.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
})

test('the browser refuses a different origin before it can carry a leased cookie there', async ({ page, testAccounts }) => {
  const foreign = new URL(page.url())
  foreign.port = foreign.port === '7777' ? '7778' : '7777'
  foreign.pathname = app('/')
  foreign.search = ''
  let apiRejected = false
  try { await page.request.get(foreign.href) } catch (error) {
    apiRejected = error instanceof Error && error.message === 'TEST_ACCOUNT_FOREIGN_ORIGIN'
  }
  expect(apiRejected).toBe(true)
  let rejected = false
  try { await page.goto(foreign.href, { waitUntil: 'commit' }) } catch { rejected = true }
  expect(rejected).toBe(true)
  expect(testAccounts.blockedOrigins()).toBe(1)
})
