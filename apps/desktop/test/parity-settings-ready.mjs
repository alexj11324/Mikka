import { expect } from '@playwright/test'

const SECTIONS = new Set(['members', 'preferences', 'memory', 'account', 'teams', 'notifications', 'security', 'connections', 'bot-permissions', 'models', 'logins', 'privacy', 'computers', 'general', 'permissions', 'secrets', 'environments', 'audit', 'usage', 'billing'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function sectionId(id) {
  if (!SECTIONS.has(id)) throw new Error('PARITY_SETTINGS_SECTION_UNKNOWN')
}

/** Observe the real successful reads before taking the screenshot. These
 * components deliberately render null for an empty/disabled result, so their
 * DOM alone cannot distinguish that result from a request still in flight.
 * Paths omit /mikka and the query; the caller binds them to this target and
 * resolves web action IDs from its actual compiled server reference manifest.
 * This list authorizes observation only, never an extra request or a mock. */
export function settingsReadRequirements(id, fixture) {
  sectionId(id)
  if (!UUID.test(fixture.workspace ?? '')) throw new Error('PARITY_SETTINGS_WORKSPACE_INVALID')
  switch (id) {
    case 'environments': return [{ path: '/api/settings/environments' }]
    case 'general': return [{ action: 'workspace-settings.listArchivedBots' }]
    case 'permissions': return [{ path: `/api/workspaces/${fixture.workspace}/computer-policy` }]
    case 'billing': return [{ path: '/api/settings/credit-billing' }]
    // 设备 no longer reads the model order (#1578): its rows render from the device list alone.
    case 'connections': return [
      { path: '/api/integrations/composio' },
      { path: '/api/integrations/github' },
      { path: '/api/integrations/linear/status' },
      { path: '/api/integrations/mcp' },
      { action: 'telegram.getTelegramIntegrationStatus' },
    ]
    // Bot 权限 lists the same connected apps (Composio and Mikka's own), without MCP servers.
    case 'bot-permissions': return [
      { path: '/api/integrations/composio' },
      { path: '/api/integrations/github' },
      { path: '/api/integrations/linear/status' },
      { action: 'telegram.getTelegramIntegrationStatus' },
    ]
    default: return []
  }
}

/** Positive application DOM states for the registered Settings pages.
 * One shared deadline, no sleeps, click retries, private React probes or UI
 * mutation. A title and an absent skeleton are never the completion signal.
 * settingsReadRequirements must also settle for the no-DOM subreads above. */
export async function settingsReady(page, id, fixture, messages) {
  sectionId(id)
  const deadline = Date.now() + 45_000
  const options = () => ({ timeout: Math.max(1, deadline - Date.now()) })
  const t = (path, values = {}) => {
    const value = path.split('.').reduce((part, key) => part?.[key], messages)
    if (typeof value !== 'string') throw new Error('PARITY_SETTINGS_MESSAGE_MISSING')
    return value.replace(/\{([A-Za-z]+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
  }
  const body = page.getByRole('main').last()
  const alerts = body.locator('[role="alert"]').filter({ visible: true })
  const text = (key, root = body, values) => root.getByText(t(key, values), { exact: true })
  const role = (kind, key, root = body, values) => root.getByRole(kind, { name: t(key, values), exact: true })
  const visible = locator => expect(locator).toBeVisible(options())
  const enabled = async locator => { await visible(locator); await expect(locator).toBeEnabled(options()) }
  const selected = group => visible(group.getByRole('radio', { checked: true }))
  const region = key => role('region', key)
  const either = (...locators) => expect.poll(async () => (await Promise.all(locators.map(locator => locator.isVisible()))).some(Boolean), options()).toBe(true)
  await visible(body)

  switch (id) {
    case 'environments':
      await visible(text('Settings.environments.empty', region('Settings.environments.title')))
      await enabled(role('button', 'Settings.environments.add'))
      break
    case 'members': {
      const table = body.getByRole('table')
      for (const name of ['Test owner', 'Test peer']) await visible(table.getByRole('checkbox', { name: `Select ${name}`, exact: true }))
      break
    }
    case 'preferences':
      await enabled(body.getByRole('textbox', { name: /^Prefix / }))
      await selected(role('radiogroup', 'Settings.appearance.themeLabel'))
      await enabled(role('radio', 'Settings.appearance.light'))
      break
    case 'memory':
      await enabled(role('switch', 'Settings.memory.learn'))
      await visible(text('Settings.memory.empty'))
      break
    case 'account':
      await expect(role('textbox', 'Settings.profile.name')).toHaveValue('Test owner', options())
      await enabled(role('button', 'Settings.profile.signOut'))
      break
    case 'teams':
      await visible(body.getByRole('tab', { name: 'Teams', selected: true, exact: true }))
      await visible(body.getByRole('list', { name: 'Teams', exact: true }).getByRole('listitem').filter({ hasText: fixture.teamName }))
      break
    case 'notifications':
      await enabled(role('switch', 'Settings.notifications.proactive'))
      await expect(role('button', 'Settings.notifications.pushWhen')).toHaveText(t('Settings.notifications.always'), options())
      break
    case 'security':
      await enabled(role('button', 'Settings.security.changePassword'))
      await visible(text('Settings.security.currentDevice'))
      await either(text('Settings.integrations.googleNotConfigured'), text('Settings.integrations.googleLinked'), role('button', 'Settings.integrations.linkGoogle').filter({ visible: true }).and(body.locator(':enabled')))
      break
    case 'connections':
      // A disabled or unreadable Linear rollout is an explicit paused row, even
      // when the account has no connections. The required reads also cover empty MCP.
      // The app list's card has no title, so it is not a labelled section: look in the page body.
      await visible(body.getByRole('tab', { name: 'All', selected: true, exact: true }))
      await either(text('Plugins.noConnections'), text('Plugins.state.paused'))
      await visible(body.getByRole('region', { name: 'Custom MCP', exact: true }).getByText('No MCP servers', { exact: true }))
      break
    case 'bot-permissions':
      // The rule's line shows once the connected apps are read; an account with none says so.
      await visible(text('Settings.botPermissions.rule'))
      await selected(role('radiogroup', 'Settings.botPermissions.mode'))
      await visible(body.getByRole('region', { name: 'Agent run permissions', exact: true }).getByRole('listitem').first())
      break
    case 'models': {
      const subscriptions = region('Settings.subscriptions.heading')
      await either(text('Settings.subscriptions.serviceOff', subscriptions), role('button', 'Settings.subscriptions.connect', subscriptions).first())
      await visible(text('Settings.apiKeys.none', region('Settings.apiKeys.sectionTitle')))
      await enabled(role('button', 'Settings.apiKeys.add').first())
      await enabled(role('switch', 'Settings.apiKeys.afterQuota'))
      await selected(role('radiogroup', 'Settings.modelOrder.location'))
      await selected(role('radiogroup', 'Settings.modelOrder.preferredAgent'))
      await expect(region('Settings.modelOrder.location')).toContainText(t('Settings.modelOrder.e2bKeyMissing'), options())
      await visible(text('Settings.agentProfiles.empty', region('Settings.agentProfiles.title')))
      const profileHeader = body.locator('header').filter({
        has: page.getByRole('heading', { level: 2, name: t('Settings.agentProfiles.title'), exact: true }),
      })
      await enabled(role('button', 'Settings.agentProfiles.add', profileHeader))
      await either(role('switch', 'Settings.subscriptionShare.others'), text('Settings.subscriptionShare.blocked'))
      break
    }
    case 'logins':
      await visible(text('Settings.secrets.empty', region('Settings.secrets.mineHeading')))
      await visible(text('Settings.logins.empty', region('Settings.logins.heading')))
      break
    case 'privacy':
      // createParityFixtures owns two different shared artifacts.
      for (const title of [fixture.artifactTitle, fixture.htmlTitle]) {
        await enabled(region('Settings.privacy.sharing').getByRole('button', { name: `${t('Settings.privacy.stopSharing')} · ${title}`, exact: true }))
      }
      break
    case 'computers': {
      const name = 'Review laptop'
      const row = body.getByRole('listitem').filter({ has: page.getByRole('switch', { name: t('Devices.allowSchedulingTo', { name }), exact: true }) })
      await visible(row)
      await expect(role('switch', 'Devices.allowSchedulingTo', row, { name })).not.toBeChecked(options())
      await expect(row).toContainText(t('Devices.offline'), options())
      await expect(row).toContainText(t('Devices.noRuns', { reason: '' }).trim(), options())
      break
    }
    case 'general':
      await expect(role('textbox', 'Settings.workspaceForm.name')).toHaveValue(fixture.workspaceName, options())
      await expect(role('textbox', 'Settings.workspaceForm.address')).toHaveValue(fixture.workspaceSlug, options())
      break
    case 'permissions':
      await visible(role('button', 'Settings.permissionsPage.block', body, { name: t('Settings.sharePolicy.label') }))
      const grid = role('grid', 'Settings.appPolicy.heading')
      for (const app of Object.values(messages.Settings.appPolicy.apps)) {
        const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: app, exact: true }) })
        await visible(row.getByRole('gridcell', { name: t('Settings.appPolicy.access.allow'), exact: true }))
      }
      // enabled:false legitimately has no computer-policy section. Its real
      // response is a separate required read, not inferred from absence.
      break
    case 'secrets':
      await visible(text('Settings.secrets.empty', region('Settings.secrets.heading')))
      break
    case 'audit':
      await visible(text('Settings.audit.empty'))
      break
    case 'usage': {
      for (const key of ['runs', 'runTime', 'balance']) await visible(text(`Settings.usage.${key}`, body.locator('dl')))
      await visible(role('tab', 'Settings.usage.byBot').and(body.locator('[aria-selected="true"]')))
      await visible(body.getByRole('tabpanel').getByRole('button').filter({ hasText: fixture.botName }))
      const chart = body.getByRole('img', { name: new RegExp('^' + t('Settings.usage.chartLabel') + ':') })
      await visible(chart)
      await expect.poll(async () => {
        const box = await chart.boundingBox()
        return Boolean(box && box.width > 0 && box.height > 0)
      }, options()).toBe(true)
      break
    }
    case 'billing':
      await visible(role('status', 'Errors.billingNotConfigured').or(body.locator('[role="status"]').filter({ hasText: t('Errors.billingNotConfigured') })).first())
      await enabled(role('switch', 'Settings.creditShare.mine'))
      break
  }
  // These are a final refusal check after positive completion, never the
  // primary ready condition. Hidden field errors and unrelated toasts do not
  // count as the open Settings page's data state.
  await expect(body.locator('[data-settings-state="error"]')).toHaveCount(0, options())
  await expect(alerts).toHaveCount(0, options())
}
