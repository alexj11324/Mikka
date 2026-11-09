import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { observedAction, publishedActions, rpcReadResult } from '../../../scripts/acceptance/read-action-transport.mjs'
import { selectWorkspaceMenuItem } from './native-document.mjs'
export { selectWorkspaceMenuItem } from './native-document.mjs'

export async function selectParityWorkspace(page, { menuName, workspaceName, basePath }) {
  await page.getByRole('button', { name: menuName, exact: true }).first().click()
  const item = page.getByRole('menuitem', { name: workspaceName, exact: false })
  // A switch assigns the same /en URL after its action finishes. The old URL
  // and ready DOM are not proof that the new document has loaded. An already
  // selected item is a product no-op and only closes its menu.
  await selectWorkspaceMenuItem(page, item)
  await page.waitForURL(url => url.pathname === `${basePath}/en` || url.pathname === `${basePath}/en/`)
  await page.getByRole('button', { name: menuName, exact: true }).first().waitFor()
}

// The build publishes the exact action name beside its ID. Observe that real
// transport only for reads whose successful empty state has no DOM of its own.
// No requests, React internals, application state or response routes are added.
export async function readActionIds(applicationDirectory) {
  const nitro = await lstat(join(applicationDirectory, '.output/mikka-build.json')).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (nitro) {
    const manifest = JSON.parse(await readFile(join(applicationDirectory, '.output/public/mikka/renderer-manifest.json'), 'utf8'))
    return new Map([...publishedActions(manifest)].map(name => [name, name]))
  }
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
  const waits = requirements.map(requirement => {
    let phase = 'response'
    let timer
    const read = page.waitForResponse(response => {
      const request = response.request()
      const pathname = new URL(response.url()).pathname
      if (requirement.path) return request.method() === 'GET' && pathname === `${basePath}${requirement.path}`
      return observedAction(request, pathname, basePath, actionIds)?.action === requirement.action
    }, { timeout: 45_000 }).then(async response => {
      assert.equal(response.ok(), true, `Read must succeed: ${requirement.path ?? requirement.action}`)
      const headers = response.headers()
      const action = observedAction(response.request(), new URL(response.url()).pathname, basePath, actionIds)
      if (requirement.action && action?.kind === 'flight') {
        // Next awaits the action before generating its Flight response, whose
        // page stream can remain open after the action result is consumed.
        // Combine that completed invocation with the caller's positive DOM
        // checks; ordinary API/RPC JSON must finish and parse below.
        assert.equal(response.status(), 200, 'The observed action must succeed')
        assert.ok((headers['content-type'] ?? '').includes('text/x-component'), 'The observed action must use its real Flight response')
        assert.ok(!headers['x-action-redirect'], 'An auth redirect is not action completion')
        return { linearUnavailable: false }
      }
      assert.ok((headers['content-type'] ?? '').includes('application/json'), 'The observed API/RPC read must return JSON')
      phase = 'body'
      assert.equal(await response.finished(), null, 'Read body must finish before capture')
      phase = 'json'
      const data = await response.json()
      assert.ok(!data?.error && data?.ok !== false, 'Successful transport must contain successful application data')
      if (requirement.action && action?.kind === 'rpc') {
        const result = rpcReadResult(data)
        assert.ok(!result?.error, 'The required RPC read must contain successful application data')
      }
      // Preserve the isolated environment's explicit unavailable status and its
      // visible error. This does not permit ignoring any other failed reads.
      return { linearUnavailable: requirement.path === '/api/integrations/linear/status' && response.status() === 200 && data?.enabled === false && data?.state === 'unavailable' }
    })
    // Ordinary JSON headers are not completion. Keep the same total deadline
    // while waiting for that real body, and report its exact unfinished phase.
    return Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`PARITY_READ_TIMEOUT:${requirement.path ?? requirement.action}:${phase}`)), 45_000)
    })]).finally(() => clearTimeout(timer))
  })
  // Attach rejection handlers immediately, including if an earlier DOM check
  // fails. A timed-out observation must never become an unhandled rejection.
  const results = Promise.allSettled(waits)
  return async () => {
    const settled = await results
    for (const result of settled) if (result.status === 'rejected') throw result.reason
    if (waits.length) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return { linearUnavailable: settled.some(result => result.status === 'fulfilled' && result.value.linearUnavailable) }
  }
}

export function pageReadRequirements(name) {
  if (name === 'coordinator-details') return [{ path: '/api/mobile/bots/coordinator' }]
  if (name === 'plugins') return [{ path: '/api/integrations/composio/catalog' }, { path: '/api/integrations/composio' }, { path: '/api/integrations/linear/status' }]
  if (name === 'new-task') return [
    { action: 'coordinator.issueCreationAvailable' }, { action: 'agents.listDevices' },
    { path: '/api/settings/model-order' }, { path: '/api/settings/e2b-key' },
    { path: '/api/factory/agent-profiles' },
  ]
  return []
}

export async function pageReady(page, name, fixture, messages, _observed = {}) {
  const text = value => page.getByText(value, { exact: true }).first().waitFor()
  const threadRows = async root => {
    const resolved = root.getByRole('button', { name: messages.Shell.threads.group.resolved.replace('{count}', '1'), exact: true })
    await expect(resolved).toHaveAttribute('aria-expanded', /^(?:true|false)$/, { timeout: 45_000 })
    if (await resolved.getAttribute('aria-expanded') === 'false') await resolved.click()
    await expect(resolved).toHaveAttribute('aria-expanded', 'true')
    // A thread row is named by its task: the immutable identifier issued by APP, then its title.
    await root.getByRole('button', { name: `${fixture.issueIdentifier} ${fixture.issueTitle}`, exact: true }).waitFor()
    await root.getByText('The review is complete. Conversations, task details and artifacts are ready.', { exact: false }).waitFor()
  }
  if (name === 'workspace-link') {
    // The deep link can show the restored chat before the bot roster and its
    // summaries arrive. Those reads also supply the Coordinator ID that makes
    // its Computer tab available; capture the actual completed workspace.
    const bots = page.getByRole('list', { name: messages.Nav.bots, exact: true })
    await bots.getByRole('button', { name: messages.Nav.coordinator, exact: true }).getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
    await bots.getByRole('button', { name: fixture.botName, exact: true }).getByText('The review is complete. The task and its artifacts are ready for you.', { exact: true }).waitFor()
    await bots.getByRole('button', { name: fixture.groupName, exact: true }).getByText('The desktop review is ready. Please check the task and its artifacts.', { exact: true }).waitFor()
    const overview = page.getByRole('complementary', { name: messages.Shell.panel.label, exact: true })
    await overview.getByRole('heading', { name: messages.Nav.coordinator, exact: true }).waitFor()
    await overview.getByRole('tab', { name: messages.Shell.panel.computer, exact: true }).waitFor()
    // A restored chat conservatively retains a history cursor. Complete this
    // two-message fixture through the ordinary UI before comparing its layout.
    const conversation = page.getByRole('region', { name: messages.Coordinator.conversation, exact: true })
    const earlier = conversation.getByRole('button', { name: messages.Common.loadMore, exact: true })
    if (await earlier.isVisible()) await earlier.click()
    await earlier.waitFor({ state: 'hidden' })
    await conversation.getByText('What should we review today?', { exact: true }).waitFor()
    await conversation.getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
  } else if (name === 'all-threads' || name === 'bot-thread-list') {
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
    // An unreadable Linear flag is not a read failure either: no alert in any case.
    await expect(apps.getByRole('alert')).toHaveCount(0)
  } else if (name === 'suggestions') {
    await text(messages.SuggestionsPage.empty)
    await page.getByRole('button', { name: messages.SuggestionsPage.connect, exact: true }).waitFor()
    await page.getByRole('region', { name: messages.Coordinator.conversation, exact: true }).getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
  } else if (name === 'artifact-library') {
    await text(fixture.artifactTitle)
    await text(fixture.htmlTitle)
  } else if (name === 'artifact-markdown' || name === 'artifact-html') {
    const dialog = page.getByRole('dialog')
    if (name === 'artifact-html') await dialog.frameLocator('iframe').getByRole('heading', { name: 'Desktop review', exact: true }).waitFor()
    const thread = dialog.locator('aside')
    await thread.getByText('The review is complete. Conversations, task details and artifacts are ready.', { exact: true }).waitFor()
    // The reader's document can finish before the thread's separate artifact
    // read. That read renders nothing while pending, so skeleton checks miss it.
    const cards = thread.locator('[data-slot="thread-artifacts"] [data-slot="artifact-card"]')
    await cards.getByText(fixture.artifactTitle, { exact: true }).waitFor()
    await cards.getByText(fixture.htmlTitle, { exact: true }).waitFor()
  } else if (name === 'task' || name === 'task-thread') {
    // The nested thread has the same accessible name. Only the task region
    // contains the editable title, so its independent reads gate this capture.
    const task = page.getByRole('region', { name: fixture.issueTitle, exact: true }).filter({ has: page.locator('#task-title') })
    await expect(task).toHaveAttribute('aria-busy', 'false', { timeout: 45_000 })
    await task.locator('#task-title:not([readonly])').waitFor()
    await task.getByText('Review conversations, task details, artifacts and workspace settings in the desktop app.', { exact: true }).waitFor()
    // Activity versions are a separate read from the task's editable fields.
    // The fixture's creation event must finish rendering before comparison.
    await task.getByText(messages.Workspace.detail.createdTask, { exact: true }).waitFor()
    if (name === 'task-thread') {
      // 活动's Agent rows have no loading placeholder. The selected row, named
      // after its Agent (one row per Agent stretch), proves that read is
      // rendered; the scoped reply proves the right pane.
      await task.getByRole('button', { name: messages.IssueThreads.open.replace('{name}', fixture.agentLabel), exact: true, pressed: true }).waitFor()
      await task.getByRole('list', { name: messages.IssueThreads.conversation, exact: true }).getByText('The review is complete. Conversations, task details and artifacts are ready.', { exact: true }).waitFor()
    }
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
