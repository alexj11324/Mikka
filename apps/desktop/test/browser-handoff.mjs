import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/**
 * The system browser of a desktop sign-in. The leased account's browser
 * already holds a web session, so the sign-in page shows that account and the
 * app gets it only after 「Continue as」. Returns the app link the loopback
 * callback page opens (src/main/app-link.ts), read from its response.
 */
export async function continueInSystemBrowser(page, external) {
  const callback = page.waitForResponse(response => {
    try {
      const url = new URL(response.url())
      return url.hostname === '127.0.0.1' && url.pathname === '/auth/callback' && response.status() === 200
    } catch { return false }
  }, { timeout: 60_000 })
  callback.catch(() => {})
  await page.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByTestId('desktop-continue').click({ timeout: 60_000 })
  const html = await (await callback).text().catch(() => '')
  return /<a id="open" href="([^"]+)"/.exec(html)?.[1] ?? null
}

/**
 * macOS only, packaged app only: hide the app, open the link the way a browser
 * does (LaunchServices), and report whether a window came to the front.
 */
export async function openAppLink(application, link, executable) {
  execFileSync(LSREGISTER, ['-f', resolve(executable, '../../..')])
  await application.evaluate(({ app }) => app.hide())
  execFileSync('/usr/bin/open', [link])
  for (let attempt = 0; attempt < 100; attempt++) {
    const front = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() && window.isFocused()))
    if (front) return true
    await new Promise(done => setTimeout(done, 150))
  }
  return false
}
