import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { selectOfficialWorkspace, taskActivityLocators } from './ui-proof-1782.mjs'

const app = resolve(process.env.MIKKA_TEST_APP_DIR)
const require = createRequire(join(app, 'package.json'))
const { chromium, expect } = require('@playwright/test')
const { selectParityWorkspace } = await import(pathToFileURL(join(app, 'apps/desktop/test/parity-page-ready.mjs')).href)

// A small owned HTML fixture exercises actual Chromium visibility, radio-menu
// semantics and document navigation. It contains no private UI implementation,
// application RPC, account, database or mocked production response. The separate
// production capture still has to pass all 20 screenshots and 12 semantic checks.
async function fixture({ narrow = false, selected = false } = {}, work) {
  let current = selected, selections = 0, browser
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname !== '/mikka/en') { response.writeHead(404); response.end(); return }
    if (url.searchParams.get('select') === '1') {
      current = true; selections++
      response.writeHead(302, { location: '/mikka/en' }); response.end(); return
    }
    const name = current ? 'Proof workspace' : 'Test personal workspace'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned menu contract fixture</title>
      <style>body{font:16px sans-serif}aside{width:264px}.open-sidebar{display:none}
      @media(max-width:900px){aside:not([data-open]){visibility:hidden}.open-sidebar{display:block}}</style>
      <button class="open-sidebar" aria-label="Open sidebar" onclick="document.querySelector('aside').dataset.open='true'">Open sidebar</button>
      <aside><span class="ui-as-ws-menu"><button class="ui-as-side__workspace" aria-haspopup="menu" aria-expanded="false"
        onclick="this.setAttribute('aria-expanded','true');document.querySelector('[role=menu]').hidden=false"><span class="ui-as-side__name">${name}</span></button>
        <div role="menu" hidden><button role="menuitemradio" aria-checked="${current}" onclick="${current ? "document.querySelector('[role=menu]').hidden=true" : "location.assign('/mikka/en?select=1')"}">Proof workspace</button></div>
      </span></aside></html>`)
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: narrow ? 390 : 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(5_000)
    let documents = 0
    page.on('domcontentloaded', () => { documents++ })
    await page.goto(`http://127.0.0.1:${server.address().port}/mikka/en`, { waitUntil: 'domcontentloaded' })
    await work({ page, selections: () => selections, documents: () => documents })
  } finally {
    if (browser) await browser.close()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('the prior public menu selector reproduces a real timeout on the official menu contract', { timeout: 20_000 }, async () => {
  await fixture({}, async ({ page, selections, documents }) => {
    const started = performance.now()
    await assert.rejects(selectParityWorkspace(page, { menuName: 'Workspace menu', workspaceName: 'Proof workspace', basePath: '/mikka' }), { name: 'TimeoutError' })
    assert.ok(performance.now() - started >= 4_500)
    assert.equal(selections(), 0)
    assert.equal(documents(), 1)
  })
})

for (const [name, narrow, selected] of [['wide', false, false], ['narrow', true, false], ['already selected', false, true]]) {
  test(`official ${name} menu uses its real control and preserves navigation semantics`, { timeout: 20_000 }, async () => {
    await fixture({ narrow, selected }, async ({ page, selections, documents }) => {
      const phases = []
      await selectOfficialWorkspace(page, { workspaceName: 'Proof workspace', basePath: '/mikka', onPhase: phase => phases.push(phase) })
      assert.equal(selections(), selected ? 0 : 1)
      assert.equal(documents(), selected ? 1 : 2)
      assert.equal(phases.includes('workspace_sidebar'), narrow)
      assert.equal(phases.includes('workspace_navigation'), !selected)
      assert.equal(phases.at(-1), 'workspace_ready')
      assert.equal(await page.locator('.ui-as-side__name').textContent(), 'Proof workspace')
    })
  })
}

test('duplicate delegation copy reproduces the unscoped failure and the activity region remains required', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // These are the public IssueDetailProperties / IssueActivity semantics,
    // with only owned text. This does not replace the production capture.
    await page.setContent(`<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
      <main role="region" aria-label="Proof task">
      <aside id="issue-properties"><span class="sr-only">Delegated to Ada</span><span>Ada</span></aside>
      <section aria-label="Task activity"><h2>Activity</h2>
        <div><span>Test owner</span><span data-event>Delegated to Ada</span></div>
        <span data-run-result="done">Done</span>
      </section></main>`)
    const task = page.getByRole('region', { name: 'Proof task', exact: true })
    const previous = task.getByText('Delegated to Ada', { exact: false })
    assert.equal(await previous.count(), 2)
    await assert.rejects(expect(previous).toBeVisible(), /strict mode violation/)
    const activity = taskActivityLocators(task, { label: 'Task activity', delegated: 'Delegated to Ada' })
    await expect(activity.region).toHaveCount(1)
    await expect(activity.delegation).toHaveCount(1)
    await expect(activity.delegation).toBeVisible()
    await expect(activity.result).toHaveCount(1)
    await expect(activity.result).toBeVisible()
    await page.locator('[data-event]').evaluate(node => node.remove())
    assert.equal(await previous.count(), 1)
    await expect(activity.delegation).toHaveCount(0)
    await page.locator('section').evaluate(node => node.remove())
    await expect(activity.region).toHaveCount(0)
    await expect(activity.result).toHaveCount(0)
  } finally { await browser.close() }
})
