// Local Electron acceptance for the offline page: with the server down the
// shell shows offline.html, and once the server is back it returns to the app
// on its own, with no click and no reload.
//
//   MIKKA_DESKTOP_APP_URL=http://127.0.0.1:3999/mikka \
//   MIKKA_DESKTOP_FLAVOR=dev pnpm --filter @mikka/desktop build
//   xvfb-run -a node apps/desktop/test/offline-reconnect.mjs
//
// The script serves the "app" itself on the built URL's port, so nothing else
// may listen there. Exit code 0 means the window came back by itself.

import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { _electron as electron } from '@playwright/test'

const appUrl = new URL(process.env.MIKKA_SMOKE_APP_URL ?? 'http://127.0.0.1:3999/mikka')
const userData = process.env.MIKKA_USER_DATA_DIR ?? '/tmp/mikka-desktop-offline'
for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) rmSync(`${userData}/${name}`, { force: true })

const fail = message => { throw new Error(message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const application = await electron.launch({
  // Chromium refuses to start its sandbox as root (CI containers); a normal user keeps it.
  args: ['.', `--user-data-dir=${userData}`, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, MIKKA_USER_DATA_DIR: userData },
  timeout: 90_000,
})

let server
try {
  const page = await application.firstWindow({ timeout: 90_000 })
  for (let i = 0; !page.url().startsWith('file:'); i++) {
    if (i > 100) fail(`offline page did not show: ${page.url()}`)
    await sleep(100)
  }
  console.log('offline', page.url().split('?')[0])
  // Past the first retry, which is the one the error page used to cancel.
  await sleep(3_000)
  if (!page.url().startsWith('file:')) fail(`left the offline page while the server was down: ${page.url()}`)

  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Mikka</title><p id="app">app</p>')
  })
  await new Promise(resolve => server.listen(Number(appUrl.port), appUrl.hostname, resolve))
  console.log('server up')

  // Backoff after two failures is at most 8s.
  for (let i = 0; !page.url().startsWith(appUrl.origin); i++) {
    if (i > 200) fail(`window did not return to the app by itself: ${page.url()}`)
    await sleep(100)
  }
  await page.locator('#app').waitFor({ timeout: 10_000 })
  console.log('returned', page.url())
  console.log('OFFLINE RECONNECT OK')
} finally {
  await application.close().catch(() => {})
  server?.close()
}
