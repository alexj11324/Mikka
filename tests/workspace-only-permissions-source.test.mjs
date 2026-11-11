import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const ROOTS = ['lib', 'app', 'components', 'workflows']
/** The legacy owner ceiling and the fold helper are the only readers of a head's policy columns. */
const POLICY_COLUMN_ALLOWED = new Set(['lib/operations/write-policy-store.ts', 'lib/coordinator/coordinator-bot.ts'])

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(file))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(file)
  }
  return out
}

const files = ROOTS.flatMap(sourceFiles)
const source = Object.fromEntries(files.map(file => [file, readFileSync(join(root, file), 'utf8')]))

test('no source still offers a per-Bot or per-worker permission layer', () => {
  for (const [file, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /\bset_write_policy\b/, `${file} still accepts the per-Bot command`)
    assert.doesNotMatch(text, /view=write_policy\b/, `${file} still offers the per-Bot view`)
    assert.doesNotMatch(text, /resolveScopedWritePermission/, `${file} still merges a second layer`)
    if (!POLICY_COLUMN_ALLOWED.has(file) && text.includes('agent_kit_heads')) {
      // A query that names the head must not also name its policy columns; the
      // workspace row is a different table and stays allowed.
      for (const match of text.matchAll(/agent_kit_heads/g)) {
        const window = text.slice(Math.max(0, match.index - 240), match.index + 240)
        assert.doesNotMatch(window, /external_write_permissions|cli_run_policy/, `${file} still reads or writes a head policy column`)
      }
    }
  }
  assert.match(source['lib/operations/write-setting-layers.ts'], /w\.external_write_permissions as workspace/)
  assert.doesNotMatch(source['lib/operations/write-setting-layers.ts'], /agent_kit_heads/)
})

test('the settings contract and page carry one workspace choice, not a Bot effective value', () => {
  const contract = source['components/slots/settings-bot-permissions-contract.ts']
  for (const gone of ['effective', 'bots?', 'botId?', 'onBot?', 'workspace: BotPermissionAction']) {
    assert.ok(!contract.includes(gone), `contract still exposes ${gone}`)
  }
  const page = source['components/settings/bot-permissions.tsx']
  assert.doesNotMatch(page, /\.effective\b/)
  assert.doesNotMatch(page, /layers\.agent|layers\.worker/)
  assert.doesNotMatch(page, /onBot/)
})

test('the browser gate takes the workspace layer only', () => {
  const visual = source['lib/cloud-computer/visual-contract.ts']
  assert.match(visual, /export function browserPermission\(effect: BrowserEffect, computer: 'allow'\|'deny', workspace: unknown\)/)
  const authority = source['lib/cloud-computer/browser-authority.ts']
  assert.doesNotMatch(authority, /agent_kit_heads/)
  assert.match(authority, /browserPermission\(effect,computer,workspace\)/)
})

test('every first-class write path reads the workspace app policy, not only the 允许使用的应用 block', () => {
  // ALE-8: the Coordinator's accountWrite checked only appBlockedForBot (workspace_app_policies) and the first-class
  // writes were missing from the workspace key map, so Gmail set to 不允许 blocked call_app_tool(GMAIL_*) while
  // send_email still sent. Both the step and the store must reach the workspace layer now.
  const steps = source['workflows/coordinator/steps.ts']
  assert.match(steps, /writeAccountAction\(userId, action, input, accountId, botId \?\? null\)/)
  const store = source['lib/pending-action-store.ts']
  assert.match(store, /accountWriteSetting\(db, userId, botId, action\)/)
  assert.match(store, /accountWriteOutcome\(setting/)
  // The key map carries the three actions, so a deny saved for the app reaches them.
  const keys = readFileSync(join(root, 'lib/operations/app-permission-keys.ts'), 'utf8')
  for (const action of ['send_email', 'create_calendar_event', 'update_calendar_event']) {
    assert.match(keys, new RegExp(`^\\s*${action}: '(gmail|googlecalendar)'`, 'm'), `${action} is in the workspace key map`)
  }
  // An approval re-reads the workspace instead of trusting the card forever.
  const pending = source['lib/pending-actions.ts']
  assert.match(pending, /approvalPolicyBlock\(userId, row\)/)
  assert.match(pending, /accountWriteSetting\(db, userId, row\.botId, row\.action\)/)
})

test('the page maps a stored legacy action key back to its app with the action -> app map', () => {
  // LEGACY_APP_ACTIONS runs app -> action; using it to read a stored key backwards hid a disconnected app whose only
  // stored key was `send_slack_message`.
  const page = source['components/settings/bot-permissions.tsx']
  assert.match(page, /import \{[^}]*LEGACY_WRITE_ACTIONS[^}]*\} from '@\/lib\/operations\/app-permission-keys'/)
  assert.match(page, /LEGACY_WRITE_ACTIONS\[key\]/)
  assert.doesNotMatch(page, /LEGACY_APP_ACTIONS\[key\]/)
})
