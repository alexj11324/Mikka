import assert from 'node:assert/strict'
import { continueInSystemBrowser } from './browser-handoff.mjs'
import { waitForBundledDocument } from './native-document.mjs'
import { waitForBundledSession } from './bundled-session.mjs'

/** Exercise one ordinary main-owned PKCE sign-in using this account's browser session. */
export async function signInBundledAccount({ application, page, browser, account, scope, origin, mark, timeout = 60_000 }) {
  mark('auth-initial-document')
  await waitForBundledDocument(page, { timeout })
  mark('auth-open-browser')
  await application.evaluate(({ shell }) => {
    globalThis.__mikkaLifecycleExternal = null
    shell.openExternal = async url => { globalThis.__mikkaLifecycleExternal = url }
  })
  const handoff = page.evaluate(() => window.mikka.bundled.signIn({ provider: 'google', locale: 'zh-CN', next: '/' }))
  let rejection
  handoff.catch(error => { rejection = error })
  let external
  for (let attempt = 0; attempt < 150; attempt++) {
    if (rejection) throw new Error('LIFECYCLE_HANDOFF_FAILED', { cause: rejection })
    external = await application.evaluate(() => globalThis.__mikkaLifecycleExternal)
    if (external) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(external, 'main opens the ordinary system-browser handoff')
  assert.equal(new URL(external).origin, origin)
  // signIn acknowledges registration and openExternal; the later loopback
  // callback navigates independently. Receive this one IPC reply before the
  // browser can destroy its originating document by completing that callback.
  await handoff
  const context = await browser.newContext({ storageState: account.storageStatePath })
  try {
    const browserPage = await context.newPage()
    mark('auth-return-navigation')
    const returned = page.waitForEvent('domcontentloaded', { timeout })
    returned.catch(() => {})
    await continueInSystemBrowser(browserPage, external)
    await returned
    mark('auth-public-session')
    const session = await waitForBundledSession(page, account.userId, { timeout })
    assert.equal(session.user.id, account.userId)
    mark('auth-record-session')
    await scope.recordResource({ type: 'session', id: session.session.id, ownerId: account.userId })
    return session
  } finally { await context.close() }
}
