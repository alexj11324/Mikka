import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import { BotPermissionsView } from '../components/settings/bot-permissions'
import { withAppPermissions } from '../lib/operations/app-permission-keys'
import type { BotPermissionApp, SettingsBotPermissionsProps } from '../components/slots/settings-bot-permissions-contract'

const app = (id: string, overrides: Partial<BotPermissionApp> = {}): BotPermissionApp => ({
  id,
  name: id === 'slack' ? 'Slack' : 'GitHub',
  account: null,
  iconUrl: null,
  actions: [{ id, name: 'All tools', value: 'default', effective: null, choices: ['default', 'allow', 'ask', 'deny'], editable: true }],
  ...overrides,
})

const props = (overrides: Partial<SettingsBotPermissionsProps> = {}): SettingsBotPermissionsProps => ({
  scope: 'workspace',
  bots: [],
  botId: null,
  onBot: () => {},
  apps: [],
  run: null,
  workspace: null,
  approvalMode: null,
  onApprovalMode: () => {},
  onAction: () => {},
  saving: false,
  error: null,
  ...overrides,
})

function render(overrides: Partial<SettingsBotPermissionsProps> = {}) {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>
    <BotPermissionsView {...props(overrides)} />
  </NextIntlClientProvider>)
}

test('the page states the workspace scope and has no per-Bot picker', () => {
  const html = render({ apps: [app('slack')] })
  assert.match(html, /These settings apply to every Bot in this workspace\./)
  assert.doesNotMatch(html, /<select|<option/)
})

test('one row per connected app shows its catalogue count and read/write marks', () => {
  const html = render({
    apps: [
      app('slack', { tools: { count: 2, readOnlyCount: 1, tools: [{ name: 'SLACK_LIST_CHANNELS', displayName: 'List channels', readOnly: true }, { name: 'SLACK_SEND_MESSAGE', displayName: 'Send message', readOnly: false }], truncated: false } }),
      app('github', { tools: { count: 3, readOnlyCount: 3, tools: [], truncated: false } }),
    ],
  })
  assert.equal((html.match(/data-slot="app-tile"|aria-hidden="true"/g) ?? []).length >= 2, true)
  assert.match(html, /Slack/)
  assert.match(html, /GitHub/)
  assert.match(html, /2 tools · 1 read-only/)
  assert.match(html, /Read channels|List channels/)
  assert.match(html, /Send message/)
  assert.match(html, /read-only/)
  assert.match(html, /can write/)
})

test('a failed catalogue says so instead of showing a count', () => {
  const html = render({ apps: [app('slack', { tools: { count: 0, readOnlyCount: 0, tools: [], truncated: false, error: 'readFailed' } })] })
  assert.match(html, /Couldn&#x27;t read the tool list|Couldn't read the tool list/)
  assert.doesNotMatch(html, /0 tools/)
})

test('run actions with no workspace entry show the run-policy default, not the Decision API', () => {
  const html = render({
    apps: [app('slack')],
    run: [{ id: 'git_push', name: 'Push code', value: 'default', effective: null, choices: ['default', 'allow', 'deny'], editable: true }],
  })
  assert.match(html, /Push code<\/span><span class="text-muted-foreground">Default \(run policy\)/)
  // The app row above may still use the Decision API default; the run row must not.
  assert.doesNotMatch(html.slice(html.indexOf('Push code')), /Default \(Decision API\)/)
})

test('an unreadable page still shows its error while the first read is out', () => {
  const html = render({ apps: null, error: "Couldn't read the permissions" })
  assert.match(html, /role="alert"/)
  assert.match(html, /Couldn&#x27;t read the permissions|Couldn't read the permissions/)
})

test('saving an app writes the app key and its legacy write key, and default clears both', () => {
  // The hook saves through this helper; both enforcement paths must see the same choice.
  assert.deepEqual(withAppPermissions({}, ['slack'], 'deny'), { slack: 'deny', send_slack_message: 'deny' })
  assert.deepEqual(withAppPermissions({ slack: 'deny', send_slack_message: 'deny' }, ['slack'], null), {})
})
