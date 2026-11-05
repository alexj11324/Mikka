import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'

// The build publishes the exact action name beside its ID. Observe that real
// transport only for reads whose successful empty state has no DOM of its own.
// No requests, React internals, application state or response routes are added.
export async function readActionIds(applicationDirectory) {
  const manifest = JSON.parse(await readFile(join(applicationDirectory, '.next/server/server-reference-manifest.json'), 'utf8'))
  const names = new Map()
  for (const [id, action] of Object.entries(manifest.node ?? {})) {
    const module = /^app\/actions\/(.+)\.tsx?$/.exec(action.filename ?? '')?.[1]
    if (module && action.exportedName) names.set(id, `${module}.${action.exportedName}`)
  }
  assert.ok(names.size, 'The tested production build must identify its real actions')
  return names
}

export function observeReads(page, requirements, actionIds, basePath) {
  const waits = requirements.map(requirement => page.waitForResponse(response => {
    const request = response.request()
    const pathname = new URL(response.url()).pathname
    if (requirement.path) return request.method() === 'GET' && pathname === `${basePath}${requirement.path}`
    if (pathname === `${basePath}/api/desktop/rpc`) {
      try { return request.postDataJSON()?.action === requirement.action } catch { return false }
    }
    return actionIds.get(request.headers()['next-action']) === requirement.action
  }, { timeout: 45_000 }).then(async response => {
    assert.equal(response.ok(), true, `Read must succeed: ${requirement.path ?? requirement.action}`)
    assert.equal(await response.finished(), null, 'Read body must finish before capture')
    const type = response.headers()['content-type'] ?? ''
    if (type.includes('application/json')) {
      const data = await response.json()
      assert.ok(!data?.error && data?.ok !== false, 'Successful transport must contain successful application data')
    }
    return true
  }))
  // Attach rejection handlers immediately, including if an earlier DOM check
  // fails. A timed-out observation must never become an unhandled rejection.
  const results = Promise.allSettled(waits)
  return async () => {
    for (const result of await results) if (result.status === 'rejected') throw result.reason
    if (waits.length) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
}

export function pageReadRequirements(name) {
  if (name === 'coordinator-details') return [{ path: '/api/mobile/bots/coordinator' }]
  if (name === 'plugins') return [{ path: '/api/integrations/composio/catalog' }, { path: '/api/integrations/composio' }]
  if (name === 'new-task') return [
    { action: 'coordinator.issueCreationAvailable' }, { action: 'agents.listDevices' },
    { path: '/api/settings/model-order' }, { path: '/api/settings/e2b-key' },
    { path: '/api/factory/agent-profiles' },
  ]
  return []
}

export async function pageReady(page, name, fixture, messages) {
  const text = value => page.getByText(value, { exact: true }).first().waitFor()
  const threadRows = async root => {
    const resolved = root.getByRole('button', { name: messages.Shell.threads.group.resolved.replace('{count}', '1'), exact: true })
    await expect(resolved).toHaveAttribute('aria-expanded', /^(?:true|false)$/, { timeout: 45_000 })
    if (await resolved.getAttribute('aria-expanded') === 'false') await resolved.click()
    await expect(resolved).toHaveAttribute('aria-expanded', 'true')
    await root.getByRole('button', { name: fixture.issueTitle, exact: true }).waitFor()
    await root.getByText('The review is complete. Conversations, task details and artifacts are ready.', { exact: false }).waitFor()
  }
  if (name === 'all-threads' || name === 'bot-thread-list') {
    await threadRows(page.getByRole('region', { name: messages.Shell.panel.allThreads, exact: true }))
  } else if (name === 'projects' || name === 'team-projects') {
    await text(messages.Projects.emptyTitle)
  } else if (name === 'plugins') {
    const apps = page.getByRole('tabpanel', { name: messages.Plugins.appsTab, exact: true })
    await apps.getByRole('heading', { name: messages.Plugins.popular, exact: true }).waitFor()
    for (const name of [messages.Settings.integrations.github, messages.Settings.linear.title, messages.Settings.telegram.title]) {
      await apps.getByRole('link', { name: messages.Settings.integrations.openApp.replace('{name}', name), exact: true }).waitFor()
    }
    await expect(apps.locator('[data-slot="app-row-pending"]')).toHaveCount(0, { timeout: 45_000 })
    await expect(apps.getByRole('alert')).toHaveCount(0)
  } else if (name === 'suggestions') {
    await text(messages.SuggestionsPage.empty)
    await page.getByRole('button', { name: messages.SuggestionsPage.connect, exact: true }).waitFor()
    await page.getByRole('region', { name: messages.Coordinator.conversation, exact: true }).getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
  } else if (name === 'artifact-library') {
    await text(fixture.artifactTitle)
    await text(fixture.htmlTitle)
  } else if (name === 'artifact-html') {
    await page.getByRole('dialog').frameLocator('iframe').getByRole('heading', { name: 'Desktop review', exact: true }).waitFor()
  } else if (name === 'task') {
    const task = page.getByRole('region', { name: fixture.issueTitle, exact: true })
    await expect(task).toHaveAttribute('aria-busy', 'false', { timeout: 45_000 })
    await task.locator('#task-title:not([readonly])').waitFor()
    await text('Review conversations, task details, artifacts and workspace settings in the desktop app.')
  } else if (name === 'new-task') {
    const dialog = page.getByRole('dialog', { name: messages.Shell.newTaskDialog.title, exact: true })
    await expect(dialog.getByRole('combobox', { name: messages.Shell.newTaskDialog.device, exact: true })).toContainText(`${messages.Shell.newTaskDialog.workspaceDefault} ·`, { timeout: 45_000 })
    await dialog.getByRole('combobox', { name: messages.Shell.newTaskDialog.bot, exact: true }).waitFor()
    await expect(dialog.getByRole('combobox', { name: messages.Settings.agentProfiles.taskProfile, exact: true })).toBeEnabled({ timeout: 45_000 })
    await expect(dialog.getByRole('textbox', { name: messages.Shell.newTaskDialog.label, exact: true })).toBeEditable()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
  } else if (/^(?:bot|coordinator)-(?:details|threads|prs|computer)$/.test(name)) {
    const bot = name.startsWith('bot-')
    const tab = name.slice(name.indexOf('-') + 1)
    const panel = page.getByRole('complementary', { name: messages.Shell.panel.label, exact: true }).getByRole('tabpanel', { name: messages.Shell.panel[tab], exact: true })
    if (tab === 'details') {
      if (bot) {
        await panel.getByRole('textbox', { name: messages.Shell.panel.publicRole.label, exact: true }).waitFor()
        await panel.getByText(fixture.artifactTitle, { exact: true }).waitFor()
        await panel.getByText(fixture.htmlTitle, { exact: true }).waitFor()
      } else await panel.getByText(messages.Shell.panel.noLibrary, { exact: true }).waitFor()
    } else if (tab === 'threads') {
      if (bot) await threadRows(panel)
      else await panel.getByText(messages.Shell.threads.empty, { exact: true }).waitFor()
    } else if (tab === 'prs') await panel.getByText(messages.Shell.panel.noPullRequests, { exact: true }).waitFor()
    else await panel.getByRole('button', { name: messages.Computer.addE2BKey, exact: true }).waitFor()
  }
}
