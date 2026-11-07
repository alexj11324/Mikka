import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { chromium } from '@playwright/test'

// This entry is deliberately limited to the independent GitHub runner. It is
// visual evidence, not a browser functional test or an OAuth acceptance flow.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('VISUAL_CAPTURE_REQUIRES_GITHUB_RUNNER')
const root = resolve('.artifacts/self-hosting-ui'), out = resolve(root, 'evidence')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const build = JSON.parse(await readFile(resolve(out, 'build.json'), 'utf8'))
if (build.commit !== commit) throw new Error('VISUAL_BUILD_COMMIT_MISMATCH')
const zh = JSON.parse(await readFile('messages/zh-CN.json', 'utf8'))
const en = JSON.parse(await readFile('messages/en.json', 'utf8'))
const scopes = ['github', 'push', 'models']
const userId = 'synthetic-visual-review-user'
const evidence = [], violations = [], pageErrors = []
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }
await mkdir(out, { recursive: true })

function fixture(path, state) {
  if (path === '/mikka/api/cloud/status') {
    if (state === 'error') return [503, { error: 'cloud_unavailable' }]
    const registered = state !== 'empty'
    return [200, { registered, serverId: registered ? '20000000-0000-4000-8000-000000000001' : null,
      serviceUrl: 'https://cloud.example.invalid/mikka/cloud', administrator: true, pushContent: 'reminder',
      team: { connected: registered, scopes: registered ? scopes : [] },
      personal: { connected: state === 'connected', revoked: state === 'revoked', scopes: state === 'connected' ? scopes : [] } }]
  }
  if (path === '/mikka/api/github/manifest') return [200, { viewerId: userId, admin: true, configured: state === 'connected',
    ...(state === 'connected' ? { slug: 'example-self-hosted-app', installUrl: 'https://github.com/apps/example-self-hosted-app/installations/new' } : {}),
    ...(state === 'error' ? { error: 'github_app_setup_failed', detail: 'encryption' } : {}) }]
  // The real Expo entry renders its signed-out ServerSelection. No fabricated
  // account session, authorization code, credential or successful POST exists.
  if (path === '/api/auth/get-session') return [200, null]
  if (path === '/api/version') return [200, {}]
  return null
}

async function serve(directory, prefix) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method !== 'GET') { violations.push(`write:${request.method}`); response.writeHead(405); response.end(); return }
      const state = new URL(request.headers.referer ?? 'http://127.0.0.1').searchParams.get('state')
      const data = fixture(url.pathname, state)
      if (data) { response.writeHead(data[0], { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data[1])); return }
      if (url.pathname.includes('/api/')) { violations.push(`unrecognized-read:${url.pathname}`); response.writeHead(404); response.end(); return }
      if (!url.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return }
      const name = decodeURIComponent(url.pathname.slice(prefix.length))
      let file = resolve(directory, name || 'index.html')
      if (!file.startsWith(`${directory}${sep}`)) { response.writeHead(404); response.end(); return }
      if (!extname(name)) file = resolve(directory, 'index.html')
      if (!(await stat(file).catch(() => null))?.isFile()) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(await readFile(file))
    } catch (error) { response.writeHead(500); response.end(); pageErrors.push(error.name) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const web = await serve(resolve(root, 'web'), '/mikka/')
const mobile = await serve(resolve(root, 'mobile'), '/')
const browser = await chromium.launch({ chromiumSandbox: true })
const origins = [web.origin, mobile.origin]
async function pageFor(viewport, theme, locale = 'zh-CN') {
  const page = await browser.newPage({ viewport, colorScheme: theme, locale, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  page.on('pageerror', error => pageErrors.push(error.message.slice(0, 400)))
  await page.route('**/*', route => {
    const request = route.request()
    if (!origins.includes(new URL(request.url()).origin) || request.method() !== 'GET') {
      violations.push(`${request.method()}:${new URL(request.url()).origin}`)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  return page
}
async function capture(page, name, source, theme, locale) {
  await page.evaluate(() => document.fonts.ready)
  const file = `synthetic-${locale}-${theme}-${name}.png`
  await page.screenshot({ path: resolve(out, file), fullPage: true, animations: 'disabled' })
  evidence.push({ file, source, theme, locale, viewport: page.viewportSize(), origin: new URL(page.url()).origin, path: new URL(page.url()).pathname + new URL(page.url()).search })
}

try {
  // Empty, configured, revoked, error, dialogs and a narrow viewport. The
  // production components own all labels, interactions and state rendering.
  for (const theme of ['light', 'dark']) {
    for (const [view, state] of [['server', 'empty'], ['server', 'connected'], ['personal', 'connected'], ['personal', 'revoked'], ['models', 'connected'], ['server', 'error'], ['github', 'empty'], ['github', 'connected'], ['github', 'error']]) {
      const page = await pageFor({ width: 1440, height: 1000 }, theme)
      try {
        await page.goto(`${web.origin}/mikka/?view=${view}&state=${state}&locale=zh-CN`)
        await page.locator(view === 'github' ? '#github-app-heading' : view === 'models' ? '#cloud-models-heading' : view === 'personal' ? '#personal-cloud-heading' : '#cloud-heading').waitFor()
        await capture(page, `${view}-${state}`, 'existing production settings components; synthetic GET records', theme, 'zh-CN')
        if (view === 'server' && state === 'connected') {
          await page.getByRole('button', { name: zh.Settings.cloud.disconnect, exact: true }).click()
          await page.getByRole('dialog').waitFor()
          await capture(page, 'server-disconnect-dialog', 'existing CloudSettings dialog; no submit', theme, 'zh-CN')
        }
        if (view === 'github' && state === 'empty') {
          await page.getByRole('button', { name: zh.Settings.integrations.githubAppCreate, exact: true }).click()
          await page.getByRole('dialog').waitFor()
          await capture(page, 'github-create-dialog', 'existing GitHubAppSettings dialog; no submit', theme, 'zh-CN')
        }
      } finally { await page.close() }
    }
    const page = await pageFor({ width: 390, height: 844 }, theme)
    try {
      await page.goto(`${web.origin}/mikka/?view=personal&state=revoked&locale=zh-CN`)
      await page.locator('#personal-cloud-heading').waitFor()
      await capture(page, 'personal-revoked-narrow', 'existing CloudSettings; team connected but personal authorization revoked', theme, 'zh-CN')
    } finally { await page.close() }
  }
  const english = await pageFor({ width: 1440, height: 1000 }, 'light', 'en')
  try {
    await english.goto(`${web.origin}/mikka/?view=github&state=empty&locale=en`)
    await english.locator('#github-app-heading').waitFor()
    await english.getByRole('button', { name: en.Settings.integrations.githubAppCreate, exact: true }).click()
    const dialog = english.getByRole('dialog')
    await dialog.getByRole('combobox').click()
    await english.getByRole('option', { name: en.Settings.integrations.githubAppOrganization, exact: true }).click()
    await dialog.getByLabel(en.Settings.integrations.githubAppOrganizationName, { exact: true }).waitFor()
    await capture(english, 'github-organization-dialog', 'existing GitHubAppSettings; organization field; no submit', 'light', 'en')
  } finally { await english.close() }

  for (const theme of ['light', 'dark']) for (const width of [375, 430]) {
    const page = await pageFor({ width, height: width === 375 ? 812 : 932 }, theme)
    try {
      await page.goto(`${mobile.origin}/`)
      const change = page.getByRole('button', { name: zh.MobileServer.change, exact: true })
      await change.waitFor()
      await capture(page, `mobile-${width}-sign-in`, 'real Expo production export; no account session', theme, 'zh-CN')
      await change.click()
      await page.getByRole('tab', { name: zh.MobileServer.selfHosted, exact: true }).waitFor()
      await capture(page, `mobile-${width}-server-choice`, 'real Expo ServerSelection; local presentation only', theme, 'zh-CN')
      await page.getByRole('tab', { name: zh.MobileServer.selfHosted, exact: true }).click()
      await page.getByLabel(zh.MobileServer.address, { exact: true }).waitFor()
      await capture(page, `mobile-${width}-self-hosted`, 'real Expo self-hosted address form; no connect or login', theme, 'zh-CN')
    } finally { await page.close() }
  }
  if (violations.length || pageErrors.length) throw new Error('VISUAL_CAPTURE_INCOMPLETE', { cause: { violations, pageErrors } })
} finally {
  await browser.close()
  await Promise.all([web.server, mobile.server].map(server => new Promise(resolve => server.close(resolve))))
}

async function fingerprints(directory, prefix = '') {
  const values = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = `${prefix}${entry.name}`
    if (entry.isDirectory()) values.push(...await fingerprints(path, `${name}/`))
    else if (entry.isFile()) { const bytes = await readFile(path); values.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
  }
  return values.sort((a, b) => a.file.localeCompare(b.file))
}
const manifest = { kind: 'visual-only', commit, run: process.env.GITHUB_RUN_ID, origins,
  synthetic: true, oauthAccepted: false, runtimeAccepted: false, reviewed: false,
  coverage: 'Existing Web component composition and real Expo Web export. GET fixtures only; dialogs and local server-choice views only.',
  limitations: 'No real account, OAuth, billing, save, server discovery, live push, native iOS keyboard, Keychain, system browser or TestFlight acceptance.',
  mobileAssets: await fingerprints(resolve(root, 'mobile')), evidence }
await writeFile(resolve(out, 'evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
await writeFile(resolve(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mikka 自托管界面审阅</title>
<style>body{font:15px/1.6 system-ui;margin:32px;max-width:1500px;color:#222;background:#f5f5f5}header,article{background:white;border-radius:12px;padding:24px;margin-bottom:24px}h1{margin-top:0}img{display:block;max-width:100%;height:auto;border:1px solid #ddd}code{overflow-wrap:anywhere}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:24px}article{margin:0}p{overflow-wrap:anywhere}</style>
<header><h1>Mikka 自托管界面审阅</h1><strong>合成数据 · 仅视觉证据 · 待拥有者审阅</strong><p>提交 <code>${escape(commit)}</code> · GitHub Actions ${escape(process.env.GITHUB_RUN_ID)}</p><p>Web 直接渲染现有设置组件、字体、样式和内容宽度；移动端使用真实 Expo 生产导出。截图展示空、连接、撤销、错误、弹窗、明暗主题及窄屏。合成状态不代表真实授权。</p><p>未验收：OAuth、计费、保存、自托管发现、推送、原生键盘、Keychain、系统浏览器、TestFlight。<a href="evidence.json">证据清单</a> · <a href="build.json">生产编译来源</a></p></header>
<section class="shots">${evidence.map(item => `<article><h2>${escape(item.file)}</h2><p>${escape(item.source)} · ${escape(item.viewport.width)} × ${escape(item.viewport.height)} · ${escape(item.locale)} · ${escape(item.theme)}</p><img loading="lazy" src="${escape(item.file)}" alt="${escape(item.file)}"></article>`).join('')}</section></html>`)
console.log(`Captured ${evidence.length} synthetic production-bundle views for commit ${commit}.`)
