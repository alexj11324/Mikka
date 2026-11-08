import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import { chromium } from '/home/agent/workspace/mikka-policy-4ec411d5/node_modules/@playwright/test/index.mjs'

const BASELINE = process.env.POLICY_BASELINE === '1'
const ACCOUNT_ONLY = process.env.POLICY_ACCOUNT_ONLY === '1'
const SOURCE = BASELINE ? 'facb389f6cc06c453e9135bb60ada1b0f302e0d9' : '4ec411d5d90b341aa65e58409f262af4a6d0734c'
const ORIGIN = 'https://app.aspectlylabs.com'
const API = `${ORIGIN}/mikka`
const PRIVACY = 'https://aspectlylabs.com/privacy'
const ACCOUNT = `${API}/settings?section=account`
const DIST = `/home/agent/workspace/policy-web-${BASELINE ? 'basefacb' : '4ec411d5'}`
const OUT = `/home/agent/workspace/policy-evidence-${ACCOUNT_ONLY ? 'account-confirmation' : BASELINE ? 'basefacb' : '4ec411d5'}`
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.json': 'application/json' }
const previewPages = new Set(['/', '/settings', '/settings/profile'])
let stage = 'credentials'
let browser

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const credentials = JSON.parse(input)
  input = ''
  assert.equal(typeof credentials.email, 'string')
  assert.equal(typeof credentials.password, 'string')
  await mkdir(OUT, { recursive: true })
  const discovery = await fetch(`${API}/api/desktop/discovery`)
  assert.equal(discovery.status, 200)
  const backend = (await discovery.json()).version
  browser = await chromium.launch({ executablePath: '/tmp/mikka-appstore-browser/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'zh-CN' })
  const apiReads = []
  context.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === ORIGIN && url.pathname.startsWith('/mikka/api/')) apiReads.push({ path: url.pathname, method: response.request().method(), status: response.status() })
  })
  await context.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url())
    if (previewPages.has(url.pathname) || url.pathname.startsWith('/_expo/') || url.pathname.startsWith('/assets/')) {
      const file = previewPages.has(url.pathname) ? join(DIST, 'index.html') : resolve(DIST, `.${decodeURIComponent(url.pathname)}`)
      assert.ok(file.startsWith(`${DIST}/`))
      try { await route.fulfill({ status: 200, body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' }) }
      catch { await route.fulfill({ status: 404, body: 'Preview asset missing' }) }
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  const files = []
  async function capture(name) {
    if (ACCOUNT_ONLY) return
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme })
        for (const textScale of [1, 2]) {
          if (textScale === 2) await page.evaluate(() => {
            window.__policyTextSizes = [...document.querySelectorAll('*')]
              .filter(element => element instanceof HTMLElement && (element.matches('input,textarea') || element.children.length === 0 && element.textContent.trim()))
              .map(element => ({ element, original: element.style.fontSize, size: Number.parseFloat(getComputedStyle(element).fontSize) }))
            for (const item of window.__policyTextSizes) item.element.style.fontSize = `${item.size * 2}px`
          })
          await page.evaluate(() => new Promise(requestAnimationFrame))
          let target = page.getByRole('button', { name: '删除账户', exact: true })
          if (name === 'signin') target = page.getByRole(BASELINE ? 'button' : 'link', { name: BASELINE ? '登录' : '隐私政策', exact: true })
          else if (name === 'settings') target = page.getByRole('button', { name: BASELINE ? '退出登录' : '隐私政策', exact: true })
          else if (BASELINE) target = page.getByText('邮箱', { exact: true })
          await target.evaluate(element => element.scrollIntoView({ block: 'center' }))
          await target.waitFor({ state: 'visible' })
          const file = `${name}-${width}-${colorScheme}-${textScale}x.png`
          await page.screenshot({ path: join(OUT, file), fullPage: true, mask: [page.getByText(credentials.email, { exact: true })] })
          files.push(file)
          if (textScale === 2) await page.evaluate(() => {
            for (const item of window.__policyTextSizes) item.element.style.fontSize = item.original
            delete window.__policyTextSizes
          })
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
  }
  async function openLink(label, role, expected) {
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole(role, { name: label, exact: true }).click(),
    ])
    await popup.waitForURL(expected, { timeout: 30000, waitUntil: 'domcontentloaded' })
    if (expected === ACCOUNT) {
      await popup.getByRole('button', { name: /删除账户|删除账号|注销账户|注销账号|Delete account/i }).waitFor({ timeout: 30000 })
      if (ACCOUNT_ONLY) {
        await popup.screenshot({ path: join(OUT, 'web-account-entry.png'), fullPage: true, mask: [popup.getByText(credentials.email, { exact: true }), popup.locator('input')] })
        files.push('web-account-entry.png')
      }
    }
    const observed = popup.url()
    await popup.close()
    return observed
  }
  stage = 'prelogin'
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '邮箱', exact: true }).waitFor()
  assert.equal(await page.getByRole('link', { name: '隐私政策', exact: true }).count(), BASELINE ? 0 : 1)
  await capture('signin')
  const preloginPrivacy = BASELINE ? null : await openLink('隐私政策', 'link', PRIVACY)
  stage = 'normal-email-signin'
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill(credentials.email)
  await page.getByLabel('密码', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '设置', exact: true }).waitFor({ timeout: 45000 })
  stage = 'settings'
  await page.getByRole('tab', { name: '设置', exact: true }).click()
  await page.getByText('版本', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await page.getByRole('button', { name: '隐私政策', exact: true }).count(), BASELINE ? 0 : 1)
  await capture('settings')
  const settingsPrivacy = BASELINE ? null : await openLink('隐私政策', 'button', PRIVACY)
  stage = 'profile'
  await page.goto(`${ORIGIN}/settings/profile`, { waitUntil: 'domcontentloaded' })
  await page.getByText('邮箱', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await page.getByRole('button', { name: '删除账户', exact: true }).count(), BASELINE ? 0 : 1)
  await capture('profile')
  const account = BASELINE ? null : await openLink('删除账户', 'button', ACCOUNT)
  assert.ok(apiReads.some(entry => entry.path === '/mikka/api/auth/sign-in/email' && entry.status === 200))
  assert.ok(apiReads.some(entry => entry.path === '/mikka/api/mobile/settings' && entry.status === 200))
  assert.equal(apiReads.filter(entry => entry.method === 'DELETE').length, 0)
  assert.equal((await (await fetch(`${API}/api/desktop/discovery`)).json()).version, backend)
  const matrix = ACCOUNT_ONLY
    ? { widths: [390], height: 844, appearance: ['light'], textScale: [1], screen: 'official web account page' }
    : { widths: [320, 390], height: 844, orientation: 'portrait', appearance: ['light', 'dark'], textScale: [1, 2], textScaleMethod: 'browser text-size simulation, native Dynamic Type unverified', excludedAxes: 'tablet and landscape unsupported in app config' }
  const evidence = { sourceCommit: SOURCE, backendCommit: backend, previewOrigin: ORIGIN, apiOrigin: API, authentication: 'normal review-account email sign-in through the real UI and unmodified production API', previewAssetFulfillment: 'only root, settings/profile HTML and Expo assets are served from the frozen cloud export', screenshotRedaction: 'review account email masked', matrix, nativeAcceptance: false, browser: browser.version(), actions: { preloginPrivacy, settingsPrivacy, account }, files, apiReads }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(evidence, null, 2))
  await context.close()
  console.log(JSON.stringify({ ok: true, sourceCommit: SOURCE, backendCommit: backend, files, actions: evidence.actions }))
}

try { await main() }
catch (error) { console.error(JSON.stringify({ ok: false, stage, error: error.name })); process.exitCode = 1 }
finally { await browser?.close() }
