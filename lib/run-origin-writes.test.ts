import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Source-only guard: every production insert into agent_runs must write the
// evidence-only provenance, every production dispatch call must name its entry,
// and provenance must never enter a dispatch digest or a list/chat projection.
// The database tests cover the values themselves.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRODUCTION_ROOTS = ['lib', 'app', 'workflows', 'packages'] as const
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const TEST_FILE = /(?:\.test|\.spec|\.db-cases)\./
const EXCLUDED_DIRS = new Set([
  'node_modules', '.next', 'out', 'dist', 'build', 'coverage', 'generated',
  'fixtures', 'fixture', '__tests__', '__mocks__', 'test', 'tests', 'e2e',
])

function source(file: string) {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) yield* walk(join(dir, entry.name))
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name)
    }
  }
}

/** Every non-test source file under the roots that can create an agent run. */
function productionSources(): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = []
  for (const root of PRODUCTION_ROOTS) {
    try {
      for (const path of walk(join(ROOT, root))) {
        files.push({ file: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') })
      }
    } catch { /* a deployment may not have every root */ }
  }
  return files
}

/** Skips a quoted string so parentheses inside it do not move the scanner. */
function skipString(text: string, start: number) {
  const quote = text[start]
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue }
    if (text[index] === quote) return index
  }
  return text.length - 1
}

/** The index of the `)` matching the `(` at `open`. */
function closeParen(text: string, open: number) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index
  }
  return text.length - 1
}

/** The whole `.values(...)` call that follows a Drizzle insert marker. */
function valuesCall(text: string, marker: number) {
  const values = text.indexOf('.values(', marker + 1)
  if (values === -1) return text.slice(marker, marker + 2_000)
  return text.slice(marker, closeParen(text, values + '.values'.length) + 1)
}

/** The SQL literal around a raw INSERT plus the parameter tail of its call. */
function sqlStatement(text: string, marker: number) {
  const start = text.lastIndexOf('`', marker), end = text.indexOf('`', marker)
  if (start === -1 || end === -1) return text.slice(marker, marker + 2_400)
  return text.slice(start, end + 1) + text.slice(end + 1, end + 801)
}

/** The full argument list of every call to `callee`, excluding its definition. */
function callsTo(text: string, callee: string) {
  const calls: string[] = []
  for (let index = text.indexOf(`${callee}(`); index !== -1; index = text.indexOf(`${callee}(`, index + 1)) {
    // `export async function queueCloudRun(` is the definition, not a call.
    if (/function\s+$/.test(text.slice(Math.max(0, index - 20), index))) continue
    calls.push(text.slice(index, closeParen(text, index + callee.length) + 1))
  }
  return calls
}

test('every production agent_runs insert writes origin', () => {
  const failures: string[] = []
  let inserts = 0
  for (const { file, text } of productionSources()) {
    const markers: number[] = []
    for (let index = text.indexOf('.insert(agentRuns)'); index !== -1; index = text.indexOf('.insert(agentRuns)', index + 1)) markers.push(index)
    for (const match of text.matchAll(/INSERT\s+INTO\s+agent_runs\b/gi)) if (match.index !== undefined) markers.push(match.index)
    for (const marker of markers.sort((a, b) => a - b)) {
      inserts++
      const drizzle = text.startsWith('.insert(agentRuns)', marker)
      const statement = drizzle ? valuesCall(text, marker) : sqlStatement(text, marker)
      if (!/\borigin\b/.test(statement)) failures.push(`${file}: ${drizzle ? 'drizzle insert' : 'raw INSERT'} without origin`)
    }
  }
  assert.ok(inserts > 0, 'the scan found no agent_runs insert; the roots or markers changed')
  assert.deepEqual(failures, [], `every production agent_runs insert must write origin:\n${failures.join('\n')}`)
})

test('every production dispatch call names its entry origin', () => {
  const failures: string[] = []
  const counts = { queueCloudRun: 0, queueTaskRun: 0 }
  // A literal `origin:` / shorthand `origin`, a spread of the canonical
  // resolver, which always returns `{ origin, originRef }`, or a pass-through of
  // the whole input object this function already resolved (see below).
  const providesOrigin = /\borigin\s*:|(?:^|[,{]\s*)origin\s*[,}]|\bresolveRunOrigin\s*\(/m
  // A dispatch that re-enters with its own already-resolved `input` carries the
  // entry inside it, the way withProjectExecution's recursion does. Recognising
  // it needs the whole function, not just the argument list, so the callee's own
  // `resolveRunOrigin(` must appear before the call.
  const passesOwnInput = (text: string, call: string) => {
    const at = text.indexOf(call)
    if (at === -1) return false
    return /\bresolveRunOrigin\s*\(/.test(text.slice(0, at)) && /\binput\s*(?:,|\))/.test(call)
  }
  for (const { file, text } of productionSources()) {
    for (const callee of ['queueCloudRun', 'queueTaskRun'] as const) {
      for (const call of callsTo(text, callee)) {
        counts[callee]++
        // The caller never relies on a hidden default.
        if (!providesOrigin.test(call) && !passesOwnInput(text, call)) failures.push(`${file}: ${callee} call without origin`)
      }
    }
  }
  for (const [callee, count] of Object.entries(counts)) assert.ok(count > 0, `no production ${callee} call found; the scan broke`)
  assert.deepEqual(failures, [], `production dispatch calls must pass origin explicitly:\n${failures.join('\n')}`)
})

test('entry refs carry only external identities, never the workspace', () => {
  // MCP names itself by kind only; the workspace stays derived from the task
  // or run and is rechecked at read time.
  assert.match(source('mcp/actions.ts'), /origin: 'api', originRef: \{ kind: 'api' \}/)
  assert.doesNotMatch(source('mcp/actions.ts'), /originRef: \{[^}]*workspaceId/)
  // The Slack event helper builds a closed object from its own fields.
  const slack = /export function slackRunOriginRef[\s\S]*?\n\}/.exec(source('run-origin.ts'))
  assert.ok(slack)
  assert.doesNotMatch(slack[0], /workspaceId/)
})

test('the entry provenance never enters a dispatch digest', () => {
  const queueLocal = source('factory/queue-local.ts')
  const selection = /selection: \[([\s\S]*?)\],\n/.exec(queueLocal)
  assert.ok(selection, 'queue-local keeps its explicit selection array')
  assert.doesNotMatch(selection[1], /origin/, 'the Factory task digest must not depend on the entry')
  const fingerprint = /export function dispatchFingerprint[\s\S]*?\n\}/.exec(source('run-dispatch.ts'))
  assert.ok(fingerprint)
  assert.doesNotMatch(fingerprint[0], /origin/, 'a retry from another entry is the same work')
})

test('origin and originRef stay out of list, brief, chat and event projections', () => {
  const agentRuns = source('agent-runs.ts')
  const view = /export const runViewColumns = \{([\s\S]*?)\n\}/.exec(agentRuns)
  assert.ok(view)
  assert.doesNotMatch(view[1], /origin/i, 'lists and chat never project the entry provenance')
  const brief = /const runBriefViewColumns = \{([\s\S]*?)\n\}/.exec(agentRuns)
  assert.ok(brief)
  assert.doesNotMatch(brief[1], /origin/i)
  assert.doesNotMatch(source('coordinator-events.ts'), /originRef/, 'coordinator events never carry opaque entry ids')
})

test('evidence is the only run read that selects origin and originRef', () => {
  eachNear('captures/store.ts', 'export async function runEvidence', /origin: agentRuns\.origin, originRef: agentRuns\.originRef/, 1_200)
})

/** Each occurrence of `marker` must carry `expected` within its statement. */
function eachNear(file: string, marker: string, expected: RegExp, window = 2_000) {
  const text = source(file)
  let index = -1, seen = 0
  while ((index = text.indexOf(marker, index + 1)) !== -1) {
    seen++
    assert.match(text.slice(index, index + window), expected, `${file}: ${marker} #${seen} must write the entry provenance`)
  }
  assert.ok(seen > 0, `${file}: expected at least one ${marker}`)
}
