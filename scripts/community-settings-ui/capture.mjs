import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { chromium } from '@playwright/test'

// Visual capture on the independent GitHub runner only. No browser functional
// test, real session, redirect, OAuth, payment or local-browser fallback.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('VISUAL_CAPTURE_REQUIRES_GITHUB_RUNNER')
const root = resolve('.artifacts/community-settings-ui'), out = resolve(root, 'evidence'), web = resolve(root, 'web')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const build = JSON.parse(await readFile(resolve(out, 'build.json'), 'utf8'))
if (build.commit !== commit) throw new Error('VISUAL_BUILD_COMMIT_MISMATCH')
const zh = JSON.parse(await readFile('messages/zh-CN.json', 'utf8'))
const userId = 'synthetic-settings-review-user', workspaceId = '10000000-0000-4000-8000-000000000001'
const evidence = [], violations = [], pageErrors = []
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }
await mkdir(out, { recursive: true })

function fixture(url, edition) {
  if (url.pathname === '/mikka/api/workspace' && url.searchParams.get('workspace') === workspaceId) {
    const workspace = { id: workspaceId, name: `合成工作区 · ${edition}`, kind: 'team' }
    return { workspace, edition, role: 'admin', currentUserId: userId,
      currentUser: { name: 'Synthetic reviewer', email: 'synthetic-review@example.invalid', image: null },
      choices: [workspace], members: [], invitations: [] }
  }
  if (url.pathname === '/mikka/api/settings/issue-prefix') return { prefix: 'DEMO', saved: 'DEMO', suggested: 'DEMO', teamKeys: [] }
  return null
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'GET') { violations.push(`write:${request.method}`); response.writeHead(405); response.end(); return }
    if (url.pathname.includes('/api/')) {
      const edition = new URL(request.headers.referer ?? 'http://127.0.0.1').searchParams.get('edition')
      const data = ['community', 'cloud'].includes(edition) ? fixture(url, edition) : null
      if (!data) { violations.push(`unrecognized-read:${url.pathname}`); response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data)); return
    }
    if (!url.pathname.startsWith('/mikka/')) { response.writeHead(404); response.end(); return }
    const name = decodeURIComponent(url.pathname.slice('/mikka/'.length))
    let file = resolve(web, name || 'index.html')
    if (!file.startsWith(`${web}${sep}`)) { response.writeHead(404); response.end(); return }
    if (!extname(name)) file = resolve(web, 'index.html')
    if (!(await stat(file).catch(() => null))?.isFile()) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(await readFile(file))
  } catch (error) { response.writeHead(500); response.end(); pageErrors.push(error.name) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ chromiumSandbox: true })
  for (const theme of ['light', 'dark']) for (const edition of ['community', 'cloud']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, locale: 'zh-CN', deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const reads = []
    page.on('pageerror', error => pageErrors.push(error.message.slice(0, 400)))
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') {
        violations.push(`${request.method()}:${url.origin}${url.pathname}`)
        return route.abort('blockedbyclient')
      }
      if (url.pathname.includes('/api/')) reads.push(url.pathname + url.search)
      return route.continue()
    })
    try {
      // The real resolver and SettingsView decide what this initial section
      // renders after the synthetic workspace GET; no fixture supplies billing visibility.
      const requestedSection = edition === 'community' ? 'billing' : 'preferences'
      await page.goto(`${origin}/mikka/settings?edition=${edition}&section=${requestedSection}`)
      await page.getByText(`合成工作区 · ${edition}`, { exact: true }).waitFor()
      await page.locator('#issue-prefix:not([disabled])').waitFor()
      await page.getByRole('heading', { name: zh.Settings.sections.preferences.title, exact: true }).waitFor()
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))
      })
      const file = `synthetic-zh-CN-${theme}-${edition}-settings.png`
      // Observations for the human review, not browser business assertions.
      const observed = {
        selectedSidebar: await page.locator('[data-slot="settings-list"] [aria-current="page"]').innerText(),
        billingItems: await page.locator('[data-slot="settings-list"]').getByRole('button', { name: zh.Settings.sections.billing.title, exact: true }).count(),
        heading: await page.locator('h1').innerText(),
        prefix: await page.locator('#issue-prefix').inputValue(),
      }
      await page.screenshot({ path: resolve(out, file), fullPage: true, animations: 'disabled' })
      evidence.push({ file, source: 'existing SettingsView, SettingsSidebar, Preferences and AppFrame; synthetic GET records',
        edition, requestedSection, observed, theme, locale: 'zh-CN', viewport: page.viewportSize(), origin,
        path: new URL(page.url()).pathname + new URL(page.url()).search, reads })
    } finally { await page.close() }
  }
  if (violations.length || pageErrors.length) throw new Error('VISUAL_CAPTURE_INCOMPLETE', { cause: { violations, pageErrors } })
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}

const manifest = { kind: 'visual-only', commit, run: process.env.GITHUB_RUN_ID, origins: [origin],
  synthetic: true, oauthAccepted: false, runtimeAccepted: false, reviewed: false,
  coverage: 'Existing SettingsView after workspace GET: community/cloud admin sidebar with real Preferences in light/dark. Community begins at the existing billing section resolver.',
  limitations: 'Component composition omits the app rail and window bar. No real session, database, URL redirect, billing, OAuth, save or runtime acceptance. No mobile or full-language matrix.', evidence }
await writeFile(resolve(out, 'evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
await writeFile(resolve(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mikka 社区版设置侧栏审阅</title>
<style>body{font:15px/1.6 system-ui;margin:32px;max-width:1500px;color:#222;background:#f5f5f5}header,article{background:white;border-radius:12px;padding:24px;margin-bottom:24px}h1{margin-top:0}img{display:block;max-width:100%;height:auto;border:1px solid #ddd}code{overflow-wrap:anywhere}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:24px}article{margin:0}p{overflow-wrap:anywhere}</style>
<header><h1>Mikka 社区版设置侧栏审阅</h1><strong>合成 GET 数据 · 仅视觉证据 · 待拥有者审阅</strong><p>提交 <code>${escape(commit)}</code> · GitHub Actions ${escape(process.env.GITHUB_RUN_ID)}</p><p>现有 SettingsView、SettingsSidebar 和偏好设置组件，使用生产 Vite 配置、原字体与样式；未渲染应用顶栏和图标栏。community 请求初始 billing 段，cloud 请求 preferences 段，截图记录工作区加载后的组件状态。</p><p>未验收：真实账号、数据库、URL 重定向、计费、OAuth、保存或运行时流程。<a href="evidence.json">证据清单</a> · <a href="build.json">生产编译来源</a></p></header>
<section class="shots">${evidence.map(item => `<article><h2>${escape(item.file)}</h2><p>${escape(item.edition)} · ${escape(item.viewport.width)} × ${escape(item.viewport.height)} · ${escape(item.theme)}</p><p>初始段 ${escape(item.requestedSection)}；实际标题 ${escape(item.observed.heading)}；计费项 ${escape(item.observed.billingItems)}</p><img loading="lazy" src="${escape(item.file)}" alt="${escape(item.file)}"></article>`).join('')}</section></html>`)
console.log(`Captured ${evidence.length} synthetic settings views for commit ${commit}.`)
