import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Source-only guard: every production insert into agent_runs must write the
// evidence-only provenance, and it must never enter a dispatch digest or a
// list/chat projection. The database tests cover the values themselves.

function source(file: string) {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

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

test('every production agent_runs insert writes origin and originRef', () => {
  // Drizzle inserts in the shared admission and the legacy dispatch helper.
  eachNear('run-admission-store.ts', '.insert(agentRuns).values(', /origin: input\.origin, originRef: input\.originRef \?\? null/)
  eachNear('run-dispatch.ts', '.insert(agentRuns).values(', /origin: brief\.origin \?\? 'factory', originRef: brief\.originRef \?\? null/)
  // Device retry copies the source run's entry.
  eachNear('run-leases.ts', '.insert(agentRuns).values(', /resolveRunOrigin\(\{ sourceRun: run/)
  // A quota continuation also copies the paused run's entry.
  eachNear('run-quota.ts', '.insert(agentRuns).values(', /resolveRunOrigin\(\{ sourceRun: run/)
  // The app's own group-chat status row is the web entry.
  eachNear('coordinator/group-turns.ts', 'INSERT INTO agent_runs', /leaseExpiresAt",origin\) VALUES \([\s\S]*'web'\)/)
  // Raw SQL: the cloud queue and the cloud question continuation.
  eachNear('computer/queue-run.ts', 'INSERT INTO agent_runs', /origin,"originRef"[\s\S]*entry\.origin, entry\.originRef \? JSON\.stringify\(entry\.originRef\) : null/)
  eachNear('factory/questions/queue-continuation.ts', 'INSERT INTO agent_runs', /origin,"originRef"[\s\S]*entry\.origin, entry\.originRef \? JSON\.stringify\(entry\.originRef\) : null/)
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
