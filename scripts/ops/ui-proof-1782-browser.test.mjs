import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { officialInboxLocators, officialTaskLocators, openOfficialOverview, selectOfficialWorkspace, taskActivityLocators } from './ui-proof-1782.mjs'

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

// These fixtures exercise selectors against the newly published accessible
// contract. They contain no hosted implementation and do not prove application
// rendering or replace any normal-RPC capture assertion.
for (const width of [1440, 390]) test(`official Overview opens through work-area controls at ${width}px and keeps the Inbox global`, { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.setDefaultTimeout(5_000)
    await page.setContent(`<style>@media(max-width:900px){nav{display:none}}</style>
      <nav class="ui-as-side__nav" aria-label="Main menu"><button class="ui-as-side__item"><span>Inbox</span><span class="ui-as-side__count" title="1">1</span></button></nav>
      <button aria-label="Open artifacts" onclick="document.querySelector('#area').hidden=false">Open artifacts</button>
      <aside id="area" aria-label="Artifacts" hidden>
        <section aria-label="Tools"><button onclick="this.closest('section').hidden=true;document.querySelector('#panel').hidden=false">Overview</button></section>
        <aside id="panel" aria-label="Right panel" hidden><h2>Ada</h2><div role="tablist" aria-label="Right panel content">
          <button role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true');document.querySelector('#rows').hidden=false">Tasks</button>
        </div><div id="rows" hidden>${['waiting', 'blocked', 'failed', 'todo', 'done'].map(state => `<button data-task-row data-task-state="${state}">${state}</button>`).join('')}</div></aside>
      </aside>`)
    assert.equal(await page.locator('[data-slot="all-threads"]').count(), 0)
    assert.equal(await page.locator('[data-slot="all-tasks"]').count(), 0)
    const panel = await openOfficialOverview(page, { overviewLabel: 'Overview', panelLabel: 'Right panel', tasksLabel: 'Tasks' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-task-row]')).toHaveCount(5)
    const inbox = officialInboxLocators(page, 'Inbox')
    await expect(inbox.item).toHaveCount(1)
    await expect(inbox.count).toHaveText('1')
    await expect(inbox.count).toHaveAttribute('title', '1')
    assert.equal(await inbox.count.isVisible(), width === 1440)
    // The counter is not sourced from this dispatcher's rendered list.
    await panel.locator('#rows').evaluate(node => { node.textContent = 'No tasks yet' })
    await expect(panel.locator('[data-task-row]')).toHaveCount(0)
    await expect(inbox.count).toHaveText('1')
  } finally { await browser.close() }
})

test('the hosted frame independently locates the human, explicit Delegate and exact historical result', { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    await page.setContent(`<main role="region" aria-label="Proof task" aria-busy="false">
      <textarea class="ui-kb-issue__title" aria-label="Task title">Proof task</textarea>
      <aside aria-label="Properties"><button aria-label="Assignee: Test owner">Test owner</button>
        <span aria-label="Delegated to Ada">Ada</span><button>In Progress</button></aside>
      <section aria-label="Activity"><h2>Activity</h2><ol>
        <li data-event><span><b>Test owner</b> Delegated to Ada · now</span></li>
      </ol></section></main>`)
    const values = { title: 'Proof task', titleLabel: 'Task title', propertiesLabel: 'Properties',
      assigneeLabel: 'Assignee: Test owner', delegateLabel: 'Delegated to Ada',
      activityLabel: 'Activity', delegated: 'Delegated to Ada', threadLabel: "Open Codex's conversation" }
    const frame = officialTaskLocators(page, values)
    await expect(frame.task).toHaveCount(1)
    await expect(frame.title).toHaveValue('Proof task')
    await expect(frame.assignee).toHaveText('Test owner')
    await expect(frame.delegate).toHaveText('Ada')
    await expect(frame.delegate).toBeVisible()
    await expect(frame.delegation).toHaveCount(1)
    await expect(frame.result).toHaveCount(0)
    await frame.properties.evaluate(node => {
      const summary = document.createElement('span')
      summary.textContent = 'Delegated to Ada'; node.append(summary)
    })
    await expect(frame.task.getByText('Delegated to Ada', { exact: false })).toHaveCount(2)
    await expect(frame.delegation).toHaveCount(1)
    await frame.activity.evaluate(node => { const duplicate = node.cloneNode(true); duplicate.setAttribute('data-duplicate', ''); node.after(duplicate) })
    await expect(frame.activity).toHaveCount(2)
    await expect(frame.delegation).toHaveCount(2)
    await page.locator('[data-duplicate]').evaluate(node => node.remove())
    await expect(frame.activity).toHaveCount(1)
    assert.equal(await frame.task.locator('#task-title').count(), 0)
    assert.equal(await taskActivityLocators(frame.task, { label: 'Task activity', delegated: values.delegated }).region.count(), 0)
    // No historical row is needed to locate an explicit delegate. Once present,
    // the result must belong to the named conversation, not the Task status.
    await frame.activity.locator('ol').evaluate(node => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.setAttribute('aria-label', "Open Codex's conversation")
      button.textContent = 'Codex Done · now'
      item.append(button); node.append(item)
    })
    await expect(frame.result).toHaveCount(1)
    await expect(frame.result).toHaveText('Codex Done · now')
    await expect(frame.properties.getByRole('button', { name: 'In Progress', exact: true })).toBeVisible()
    await frame.activity.locator('[data-event]').evaluate(node => node.remove())
    await expect(frame.delegation).toHaveCount(0)
    await expect(frame.delegate).toHaveCount(1)
    await expect(frame.task.getByText('Delegated to Ada', { exact: false })).toHaveCount(1)
    await frame.activity.evaluate(node => node.remove())
    await expect(frame.result).toHaveCount(0)
    // The old public frame cannot silently stand in for this hosted frame.
    await frame.title.evaluate(node => { node.className = ''; node.id = 'task-title' })
    await expect(frame.task).toHaveCount(0)
  } finally { await browser.close() }
})
