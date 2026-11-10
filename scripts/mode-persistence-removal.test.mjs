// ALE-4: the per-task mode persistence must not exist, and a continuation must
// not be able to rewrite a person's choice.
//
// This suite reads the source rather than a database. The reason is the point:
// with no `task_thread_modes` row and no `agent_runs.mode` column there is no
// shared row for a continuation to copy over, so there is nothing to revert and
// no false `thread.mode_changed` audit to write. A DB test could only prove the
// code did not happen to write a row; this proves the row cannot exist.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = path => readFileSync(join(root, path), 'utf8')

/** Every tracked text file, so a new file cannot quietly reintroduce the term.
 * This suite is skipped: it necessarily names the terms it forbids. */
const SELF = 'scripts/mode-persistence-removal.test.mjs'
function trackedFiles(extraArgs = []) {
  return execFileSync('git', ['ls-files', ...extraArgs], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(path => path !== SELF)
}

function filesMatching(pattern) {
  const found = []
  for (const path of trackedFiles()) {
    if (!/\.(ts|tsx|mjs|mts|sql|json|md)$/.test(path)) continue
    const source = read(path)
    if (pattern.test(source)) found.push(path)
  }
  return found
}

test('no table and no column for a per-task mode', () => {
  // The migration that once created them is gone; the surviving one creates
  // only the approval columns that are actually used.
  assert.deepEqual(trackedFiles().filter(path => /thread[_-]modes?\.sql$/.test(path)), [])
  assert.ok(trackedFiles().includes('drizzle/20261110220000_tool_approval_decisions.sql'))
  // No tracked source names the table, except the decision record that says
  // it was removed: a decision must be able to name what it deleted.
  const naming = filesMatching(/task_thread_modes/)
  assert.deepEqual(naming, ['docs/design/decisions/2026-11-10-1730-tool-approvals.md'])
})

test('the run schema carries no mode column', () => {
  const schema = read('lib/db/schema.ts')
  // `mode` is still a word in this file for `modelDispatch` and relation
  // helpers; what must not exist is a column on the run or a mode table.
  assert.ok(!/pgTable\(\s*'task_thread_modes'/.test(schema))
  const runs = schema.slice(schema.indexOf("export const agentRuns"), schema.indexOf("export const runPublications"))
  assert.ok(runs.length > 0, 'agentRuns table not found')
  assert.ok(!/^\s*mode: text\('mode'\)/m.test(runs), 'agent_runs must not carry a mode column')
})

test('no code reads or writes the removed persistence', () => {
  // The store, its DB test, the transition route, the picker and its hook.
  for (const path of [
    'lib/thread-mode/store.ts',
    'lib/thread-mode/store.db.test.ts',
    'lib/thread-mode/support.ts',
    'lib/thread-mode/view.ts',
    'app/api/threads/[runId]/mode/route.ts',
    'hooks/use-thread-mode.ts',
    'components/workspace/thread-mode-picker.tsx',
  ]) assert.ok(!trackedFiles().includes(path), `${path} must stay deleted`)
})

test('a continuation carries read-only intent and nothing else', () => {
  // The provider fallback copies `readOnly` from the source run's own frozen
  // definition and passes no mode: there is no shared row to rewrite, so a
  // continuation cannot revert a newer choice or write a false audit row.
  const fallback = read('lib/agent-runs.ts')
  assert.ok(fallback.includes('readOnly: current.agentDefinition.readOnly'))
  assert.ok(!/carriedMode/.test(fallback))
  const provider = read('lib/run-provider-fallback.ts')
  assert.ok(provider.includes('readOnly: source.agentDefinition.readOnly'))
  assert.ok(!/carriedMode|source\.mode\b/.test(provider))
  // Admission compares a replay against read-only intent, never a mode.
  const admission = read('lib/run-admission-store.ts')
  assert.ok(admission.includes('const expectedReadOnly = input.definition.readOnly === true'))
  assert.ok(!/expectedMode|freezeThreadMode|readThreadMode/.test(admission))
})

test('no transition API and no per-thread mode audit action remain', () => {
  assert.deepEqual(filesMatching(/threadModeLocked|threadModeChanged|threadModeUnsupported/), [])
  assert.deepEqual(filesMatching(/'thread\.mode_changed'/), [])
  // The route manifest must not serve a deleted route.
  assert.ok(!/\/api\/threads\/\[runId\]\/mode/.test(read('apps/api/generated/routes.json')))
})

test('the harness approval matrix is what replaced the three-state mode', () => {
  // What survives is the honest capability report, renamed so it no longer
  // collides with `threadMode` (Capy's new-thread vs standing-thread setting).
  const protocol = read('packages/protocol/src/harness-approval.ts')
  assert.ok(protocol.includes('HARNESS_TOOL_APPROVAL'))
  assert.ok(protocol.includes('harnessCanAsk'))
  // The harness that cannot ask is refused at claim, never run unapproved.
  const claim = read('app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts')
  assert.ok(!/threadModeSupport|threadModeSchema|threadModes/.test(claim))
  // The daemon advertises the gate it really has, not a list of modes.
  const main = read('packages/daemon/src/main.ts')
  assert.ok(!/THREAD_MODES|threadModes/.test(main))
  assert.ok(/supportsToolApproval/.test(main))
})
