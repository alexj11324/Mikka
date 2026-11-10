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
