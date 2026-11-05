import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = '/tmp/issue1284-front-render-ec901cd9'
const source = root + '/source/status-card.html'
const output = root + '/captures'
const expected = 'ec901cd906938c2d903ac81afa19345f2f05b3a9e23a1659770c7d66d088dad8'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = await fs.readFile(source)
if (bytes.length !== 1486 || hash(bytes) !== expected) throw new Error('source_hash_mismatch')
await fs.mkdir(output, { recursive: true })
const require = createRequire('/workspace/Mikka/package.json')
const { chromium } = require('@playwright/test')
const childPids = async () => {
  try { return (await fs.readFile('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch { return [] }
}
const manifest = {
  kind: 'isolated-standalone-html-render',
  source: { path: 'source/status-card.html', bytes: bytes.length, sha256: hash(bytes), provenance: 'Root supplied the actual file extracted from normal production Changes UI. This capture independently verifies those exact bytes before and after rendering; it does not re-access production.' },
  startedAt: new Date().toISOString(),
  screenshotProcessPid: process.pid,
  renderer: { name: 'Chromium', version: null, headless: true, browserProcessIds: [] },
  method: { input: 'file URL', deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light', offline: true, fullPage: false, styleOrSourceOverrides: false, readiness: 'load, document.fonts.ready, two ordinary animation frames', newNextOrDatabaseService: false },
  captures: [],
  contextsClosed: false,
  browserClosed: false,
  boundaries: [
    'Screenshot-only rendering of the actual self-contained HTML, with no browser test suite or app test.',
    'No production browser, production API, database, model call, account session or app service is used.',
    'This is isolated Docker Chromium visual evidence. It does not establish that the native-agent Chrome SIGABRT is fixed, and it does not replace the preserved review result.'
  ]
}
let browser
const contexts = []
let failure
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  manifest.renderer.version = browser.version()
  manifest.renderer.browserProcessIds = await childPids()
  for (const viewport of [{ width: 1024, height: 768 }, { width: 400, height: 800 }]) {
    const name = 'status-card-ec901cd9-' + viewport.width + 'x' + viewport.height + '.png'
    try { await fs.access(output + '/' + name); throw new Error('existing_capture_preserved') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light', offline: true })
    contexts.push(context)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push({ name: error.name }))
    const startedAt = new Date().toISOString()
    await page.goto(pathToFileURL(source).href, { waitUntil: 'load', timeout: 15000 })
    await page.evaluate(async () => { await document.fonts.ready })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const dom = await page.evaluate(() => ({
      title: document.title,
      heading: document.querySelector('h1')?.textContent ?? null,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      gridColumns: getComputedStyle(document.querySelector('.cards')).gridTemplateColumns,
      cards: [...document.querySelectorAll('.card')].map(card => { const rect = card.getBoundingClientRect(); return { text: card.textContent?.replace(/\s+/g, ' ').trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    }))
    await page.screenshot({ path: output + '/' + name, fullPage: false })
    const image = await fs.readFile(output + '/' + name)
    manifest.captures.push({ path: name, bytes: image.length, sha256: hash(image), viewport, startedAt, finishedAt: new Date().toISOString(), dom, pageErrors: errors })
    await context.close()
    contexts.pop()
  }
} catch (error) {
  failure = error
  manifest.failure = { name: error?.name ?? 'Error', code: error?.code ?? null }
} finally {
  for (const context of contexts) await context.close()
  manifest.contextsClosed = true
  if (browser) { await browser.close(); manifest.browserClosed = true }
  manifest.finishedAt = new Date().toISOString()
  manifest.remainingDirectChildPids = await childPids()
  manifest.sourceUnchangedAfterCapture = hash(await fs.readFile(source)) === expected
  const scriptBytes = await fs.readFile(root + '/capture.mjs')
  manifest.script = { path: 'capture.mjs', bytes: scriptBytes.length, sha256: hash(scriptBytes) }
  await fs.writeFile(output + '/capture-manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
}
console.log(JSON.stringify({ captureCount: manifest.captures.length, browserVersion: manifest.renderer.version, contextsClosed: manifest.contextsClosed, browserClosed: manifest.browserClosed, remainingDirectChildPids: manifest.remainingDirectChildPids, sourceUnchangedAfterCapture: manifest.sourceUnchangedAfterCapture, manifest: output + '/capture-manifest.json' }))
if (failure) throw failure
