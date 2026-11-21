import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { auditNoModeLayer, modeLayerHits, modeLayerPathHits, modeLayerTokens } from './no-mode-layer.mjs'

const names = (source, file) => modeLayerHits(source, file).map((hit) => hit.name)

test('main carries no thread mode layer', () => {
  const { findings, scanned } = auditNoModeLayer()
  assert.ok(scanned > 1000, `scan saw only ${scanned} files`)
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line}: ${f.name}`), [], 'a thread mode layer arrived without its decision')
})

// The guard is worthless if it cannot fail. These are the shapes the layer would
// actually take, so a silent pass here would mean the tokens never match anything.
for (const [label, source, name] of [
  ['the mode table', 'ALTER TABLE task_thread_modes ADD COLUMN kind text;', 'task_thread_modes table'],
  ['a created mode table', 'CREATE TABLE IF NOT EXISTS thread_modes (run_id uuid, mode text);', 'thread_modes table'],
  ['a mode column', 'SELECT "thread_mode" FROM agent_runs', 'thread_mode column'],
  ['a mode column in camelCase', 'db.update(agentRuns).set({ thread_mode: mode })', 'thread_mode column'],
  ['the type', 'export type ThreadMode = "plan" | "act" | "review"', 'ThreadMode type'],
  ['a parsed binding', 'const threadMode = parseThreadMode(body)', 'threadMode binding'],
  ['an imported module', "import { parseMode } from '@/lib/thread-mode/store'", 'thread-mode module or route'],
  ['a route call', "await fetch(`/api/threads/${runId}/mode`, { method: 'POST' })", 'thread-mode module or route'],
  ['the store schema', "await db.query('INSERT INTO thread_mode (run_id) VALUES ($1)')", 'thread_mode column'],
]) test(`catches ${label}`, () => assert.deepEqual(names(source, 'lib/accidental-mode.ts'), [name], label))

test('the layer is caught by path even when its contents are opaque', () => {
  assert.deepEqual(modeLayerPathHits('lib/thread-mode/store.ts'), ['/^lib\\/thread-mode\\//'])
  assert.deepEqual(modeLayerPathHits('app/api/threads/[runId]/mode/route.ts'), ['/^app\\/api\\/threads\\/\\[runId\\]\\/mode\\//'])
  assert.deepEqual(modeLayerPathHits('lib/thread-runs.ts'), [])
  assert.deepEqual(modeLayerPathHits('app/api/threads/[runId]/reply/route.ts'), [])
})

// The reason the matcher is case-sensitive and word-bounded: main carries the
// provider-fallback model view legitimately, and `mode` is a prefix of `model`.
test('the model-fallback view is not the mode layer', () => {
  for (const source of [
    'const view: ThreadModelFallbackView = { runId, state: "switched" }',
    'if (!previous.cloud) throw new ComputerError(409, "threadModelUnavailable")',
    'assert.match(html, /data-thread-model-switch/)',
    'const eligible = proof.files.filter(file => regular(file.oldMode) && regular(file.newMode))',
    'const access_mode = "shared"',
    'a thread model and its model choice',
  ]) assert.deepEqual(names(source, 'lib/run-model-fallback-view.ts'), [], source)
})

test('a decision log may name the layer; code may not', () => {
  const source = 'CREATE TABLE task_thread_modes (run_id uuid);'
  assert.deepEqual(names(source, 'docs/design/decisions/2026-11-11-1200-thread-modes.md'), [])
  assert.deepEqual(names(source, 'lib/factory/store.ts'), ['task_thread_modes table'])
})

// End to end: a real tree with a real tracked file, so the git-based audit (not just
// the string matcher) is proven to see a regression.
test('the audit finds a mode layer introduced into a real repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-no-mode-layer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: root })
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  write('lib/thread-runs.ts', 'export const runs = []')
  execFileSync('git', ['add', '.'], { cwd: root })
  assert.deepEqual(auditNoModeLayer(root).findings, [], 'the clean tree must pass first')

  write('lib/thread-mode/store.ts', 'export const mode = "plan"')
  write('lib/thread-runs.ts', 'export const threadMode = "act"')
  execFileSync('git', ['add', '.'], { cwd: root })
  const { findings } = auditNoModeLayer(root)
  assert.ok(findings.some((f) => f.file === 'lib/thread-mode/store.ts' && f.name.startsWith('/^lib')), 'a new module under lib/thread-mode/ is the layer')
  assert.ok(findings.some((f) => f.file === 'lib/thread-runs.ts' && f.name === 'threadMode binding'), 'a threadMode binding in existing code is caught')
})

test('every token is reachable by at least one sample', () => {
  const samples = ['task_thread_modes', 'thread_modes', 'thread_mode', 'ThreadMode', 'threadMode', 'thread-mode']
  assert.deepEqual(modeLayerTokens.map(([name]) => name).length, samples.length)
  for (const sample of samples) assert.ok(names(`x ${sample} y`, 'lib/x.ts').length === 1, sample)
})
