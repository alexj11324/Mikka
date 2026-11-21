import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from '@/lib/intl/i18n-client'
import messages from '../messages/en.json'
import { BotPermissionsView } from '../components/settings/bot-permissions'
import type { SettingsBotPermissionsProps } from '../components/slots/settings-bot-permissions-contract'

const props = (overrides: Partial<SettingsBotPermissionsProps> = {}): SettingsBotPermissionsProps => ({
  run: null,
  approvalMode: null,
  onApprovalMode: () => {},
  onAction: () => {},
  saving: false,
  error: null,
  ...overrides,
})

function render(overrides: Partial<SettingsBotPermissionsProps> = {}) {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <BotPermissionsView {...props(overrides)} />
  </NextIntlClientProvider>)
}

const push = { id: 'git_push', name: 'Push code', value: 'default', choices: ['default', 'allow', 'deny'], editable: true } as const

test('the run page exposes only execution settings', () => {
  const html = render({
    run: [{ ...push, choices: [...push.choices] }],
    approvalMode: { value: 'ask', editable: true },
  })
  assert.match(html, /<select[^>]+aria-label="Push code"/)
  assert.match(html, /Default \(run policy\)/)
  assert.doesNotMatch(html, /Decision API|All tools|connected app/i)
})

test('members read execution modes without edit controls', () => {
  const html = render({
    run: [{ ...push, choices: [...push.choices], editable: false }],
    approvalMode: { value: 'read_only', editable: false },
  })
  assert.match(html, /Read only/)
  assert.match(html, /Push code/)
  assert.doesNotMatch(html, /<select/)
})

test('an unreadable page shows the failure', () => {
  const html = render({ error: "Couldn't read the permissions" })
  assert.match(html, /role="alert"/)
  assert.match(html, /Couldn&#x27;t read the permissions|Couldn't read the permissions/)
})
