import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig, type Middleware } from 'swr'
import { NextIntlClientProvider } from 'next-intl'
import en from '../../messages/en.json'
import type { BotOverviewProps } from '../slots/bot-overview-contract'
import type { SettingsMembersProps } from '../slots/settings-members-contract'

const identity = (value: { children: ReactNode }) => value.children
const none = () => null
let overview: BotOverviewProps | undefined
let members: SettingsMembersProps | undefined
const team = { role: 'member', workspace: { id: 'workspace-one', name: 'Shared', kind: 'team' }, edition: 'cloud' }
let workspace: typeof team | undefined = team
let readError: Error | undefined
const writes: unknown[] = []
const cacheKeys: unknown[] = []
const computerScopes: unknown[] = []
const recordKeys: Middleware = next => (key, fetcher, config) => {
  if (key) cacheKeys.push(key)
  return next(key, fetcher, config)
}
mock.module('./e2b-key-dialog', { namedExports: { E2BKeyDialog: none, useOwnE2BKey: none, useE2BKeyStatus: (scope: string | null) => { if (scope) computerScopes.push(scope); return {} } } })
const slot = (name: string, exports: Record<string, unknown>) =>
  mock.module(new URL('../slots/' + name + '.tsx', import.meta.url).href, { namedExports: exports })

slot('bot-overview', { BotOverview: (props: BotOverviewProps) => { overview = props; return <strong>{props.conversation.name}</strong> } })
slot('panel-header', { PanelHeader: () => <header>Overview header</header>, PANEL_INITIAL_WIDTH: null })
slot('settings-members', { MembersScreen: (props: SettingsMembersProps) => { members = props; return <strong>{props.section}</strong> } })
for (const [name, member] of [
  ['settings-models', 'ApiAndSubscriptions'], ['settings-security', 'SecurityAndSignIn'],
  ['settings-preferences', 'PreferencesSettings'], ['settings-general', 'WorkspaceGeneral'],
]) slot(name, { [member]: none })
slot('settings-organization', { OrganizationSettings: none, ORGANIZATION_SETTINGS: false })
slot('settings-content', { SettingsContentFrame: identity })
slot('settings-governance', { GovernancePlan: none, GovernanceUsage: none, GovernanceTemplates: none })
mock.module('../nav/use-save-bot', { namedExports: { useSaveBot: () => async (id: string, patch: unknown) => { writes.push({ id, patch }) } } })
mock.module('./settings-sidebar', { namedExports: { SettingsSidebar: none } })
mock.module('@/hooks/use-workspace', { namedExports: { useWorkspace: () => ({ data: workspace, error: readError }) } })
mock.module('@/i18n/navigation', { namedExports: { Link: identity, usePathname: () => '/settings', useRouter: () => ({}) } })
// The inactive settings sections and computer surfaces have their own data and tests.
for (const [path, exports] of Object.entries({
  '../nav/thread-list': ['ThreadList', 'threadName'],
  '../nav/bot-look-picker': ['BotLookPicker'],
  '../computer/computer-screen': ['ComputerScreen'],
  '../computer/computer-viewer': ['ComputerViewer'],
  '../computer/computer-agents': ['useConversationThread'],
  './bot-permissions': ['BotPermissionsSettings'],
  '../plugins/plugins-view': ['PluginsView'],
  './team-permissions-settings': ['TeamPermissionsSettings'],
  './payment-designation-settings': ['PaymentDesignationSettings'],
  './account-settings': ['AccountSettings'],
  './environments-settings': ['EnvironmentsSettings'],
  './cloud-settings': ['CloudSettings'],
  './privacy-settings': ['PrivacySettings'],
  './secrets-page': ['SecretsPage'],
  '../devices/devices-settings': ['DevicesSettings'],
  './memory-settings': ['MemorySettings'],
  './notifications-settings': ['NotificationSettings'],
  './access-tokens-settings': ['AccessTokensSettings'],
  './audit-log-settings': ['AuditLogSettings'],
  './usage-settings': ['UsageSettings'],
  './billing-settings': ['BillingSettings'],
  '@/lib/settings-prefetch': ['prefetchSettingsSection'],
})) mock.module(path, { namedExports: Object.fromEntries(exports.map(name => [name, none])) })
let ContextPanel: typeof import('../nav/context-panel')['ContextPanel']
let BotOverviewBody: typeof import('../nav/bot-overview')['BotOverviewBody']
let SettingsView: typeof import('./settings-view')['SettingsView']
before(async () => {
  ;({ ContextPanel } = await import('../nav/context-panel'))
  ;({ BotOverviewBody } = await import('../nav/bot-overview'))
  ;({ SettingsView } = await import('./settings-view'))
})
const render = (node: ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><SWRConfig value={{ use: [recordKeys] }}>{node}</SWRConfig></NextIntlClientProvider>)

test('frame tab, standalone column and sheet expose the same Bot identity and edit command', async () => {
  const bot = { id: 'bot-one', name: 'Studio', kind: 'bot' as const }
  const props = { conversation: bot, threads: [], issues: [], onClose: none, onOpenThread: none, workspaceId: team.workspace.id }
  for (const placement of [{ frameTab: true, sheet: true }, { frameTab: false, sheet: false }, { frameTab: false, sheet: true }]) {
    const previous = overview
    const html = render(<ContextPanel {...props} {...placement} />)
    assert.notEqual(overview, previous, 'every placement must mount the official renderer itself')
    assert.equal(html.includes('Overview header'), !placement.frameTab)
    assert.ok(overview?.edit)
    assert.equal(overview.conversation.id, bot.id)
    assert.equal(await overview.edit.rename(' New name '), null)
  }
  assert.deepEqual(writes, Array.from({ length: 3 }, () => ({ id: bot.id, patch: { name: 'New name' } })))
  render(<ContextPanel {...props} conversation={{ ...bot, kind: 'coordinator' }} />)
  assert.equal(overview?.edit, null)
})

test('only the visible Bot tab activates library, role or computer reads', () => {
  const bot = { id: 'bot-one', name: 'Studio', kind: 'bot' as const }
  const props = { conversation: bot, tabs: [], onTab: none, query: null, onQuery: none, workspaceId: team.workspace.id, threads: [], issues: [], tasks: null, computer: { botId: bot.id, name: bot.name } }
  for (const tab of ['threads', 'prs', 'details', 'computer'] as const) {
    cacheKeys.length = 0
    computerScopes.length = 0
    render(<BotOverviewBody {...props} tab={tab} />)
    const reads = cacheKeys.filter(Array.isArray).map(key => key[0])
    assert.deepEqual(reads.sort(), tab === 'details' ? ['bot-library', 'bot-public-role'] : [])
    assert.deepEqual(computerScopes, tab === 'computer' ? [team.workspace.id] : [])
  }
})

test('Settings routes team and member state only through the resolved official provider', () => {
  const props = { user: { name: 'Member', email: 'member@example.test' }, workspaceId: team.workspace.id, onRail: none, onSignOut: none, signingOut: false, accountError: '' }
  for (const section of ['teams', 'members'] as const) {
    render(<SettingsView {...props} activeSection={section} inviteInitially />)
    assert.ok(members)
    assert.equal(members.section, section)
    assert.equal(members.workspaceId, team.workspace.id)
    assert.equal(members.inviteInitially, true)
    members = undefined
  }
  assert.match(render(<SettingsView {...props} activeSection="members" preview />), /Couldn't load the workspace|Couldn&#x27;t load the workspace/)
  assert.equal(members, undefined)
  readError = new Error('revoked')
  render(<SettingsView {...props} activeSection="members" />)
  assert.equal(members, undefined, 'a failed authorization refresh cannot reuse cached Team membership')
  readError = undefined
  render(<SettingsView {...props} workspaceId="different-team" activeSection="teams" />)
  assert.equal(members, undefined, 'a cached team cannot open the directory for another workspace')
  workspace = undefined
  assert.match(render(<SettingsView {...props} activeSection="teams" />), /role="status"/)
  assert.equal(members, undefined)
})
