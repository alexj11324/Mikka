import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifiedCiSuiteTransport } from './ci-suite-transport.ts'

const sha = 'a'.repeat(40)
const event = {
  id: 'event-id',
  kind: 'run_report',
  runId: 'run-id',
  botId: 'bot-id',
  dedupeKey: `github_ci_suite:run-id:acme/app:${sha}:77:failure`,
  observedRun: { id: 'run-id', status: 'succeeded', finishedAt: '2026-11-11T18:00:00Z' },
  payload: {
    source: 'github_ci_suite', repository: 'acme/app',
    pullUrl: 'https://github.com/Acme/App/pull/12',
    headSha: sha, suiteId: 77, conclusionHint: 'failure',
  },
}
test('only verified host-owned CI results reach the model-free Coordinator fast path', () => {
  assert(verifiedCiSuiteTransport(event))
  const cases = [
    { kind: 'user_message' }, { kind: 'run_finished' },
    { observedRun: null }, { observedRun: { id: 'other-run', status: 'succeeded', finishedAt: '2026-11-11T18:00:00Z' } },
    { observedRun: { id: 'run-id', status: 'running', finishedAt: null } },
    { runId: 'other-run' }, { botId: null }, { dedupeKey: 'run_report:run-id:xyz' },
    { payload: { ...event.payload, source: 'oauth_agent_mcp' } },
    { payload: { ...event.payload, headSha: 'b'.repeat(40) } },
    { payload: { ...event.payload, pullUrl: 'https://github.com/other/app/pull/12' } },
    { payload: { ...event.payload, suiteId: -1 } },
    { payload: { ...event.payload, conclusionHint: 'pending' } },
  ]
  for (const invalid of cases) {
    // Pending is a valid string shape but never produces this source-bound
    // outbox key unless the fully matched value was committed by the host.
    if (invalid.payload?.conclusionHint === 'pending') {
      assert(!verifiedCiSuiteTransport({ ...event, ...invalid }))
    } else {
      assert(!verifiedCiSuiteTransport({ ...event, ...invalid }), JSON.stringify(invalid))
    }
  }
})
