import { expect, it } from 'vitest'
import { McpHttpTimingCollector, MCP_HTTP_CHILD_LIMIT, MCP_HTTP_REQUEST_LIMIT } from './mcp-http-timing'
import { RunRuntimeTimings } from './run-runtime-timing'
import { runIdHash } from './tracing'

const child = 'a'.repeat(32)
const event = (type: string, sequence: number, fields: Record<string, unknown> = {}) => ({ version: 3, child, type,
  sequence, at: 1000, lost: 0, ...fields })
const start = () => event('child_start', 1)
const begin = (sequence = 2, request = 1) => event('request_start', sequence, { request, operation: 'decision_catalogue' })
const end = (sequence = 3, request = 1) => event('request_end', sequence, { request, status: 200, outcome: 'ok', durationMs: 3.25 })
const collector = (remote = 0) => new McpHttpTimingCollector('private-run', 'codex', remote, () => 1000)

it('binds local catalogue readiness to the exact claim metadata without inventing a physical send', () => {
  const hash = 'b'.repeat(64)
  const value = new McpHttpTimingCollector('private-run', 'codex', 0, () => 1000, hash)
  expect(value.accept(start())).toBe(true)
  expect(value.accept(event('catalogue_ready', 2, { source: 'claim', sha256: 'c'.repeat(64) }))).toBe(false)
  expect(value.accept(event('catalogue_ready', 2, { source: 'claim', sha256: hash, schema: 'PRIVATE_SCHEMA' }))).toBe(false)
  expect(value.accept(event('catalogue_ready', 2, { source: 'claim', sha256: hash }))).toBe(true)
  expect(value.accept(event('catalogue_ready', 3, { source: 'claim', sha256: hash }))).toBe(false)
  expect(value.accept(event('child_close', 3, { sent: 0, completed: 0 }))).toBe(true)
  expect(value.finish()).toMatchObject({ version: 3, expectedCatalogueSha256: hash, requests: [],
    children: [{ lastSequence: 3, sent: 0, completed: 0, catalogue: { source: 'claim', sha256: hash, readyAt: 1000 } }],
    observedComplete: false, rejectedEvents: 3, allFirstPartyHttpComplete: false })
  const absent = collector(); absent.accept(start())
  expect(absent.accept(event('catalogue_ready', 2, { source: 'claim', sha256: hash }))).toBe(false)
})

it('keeps response headers separate from the later body completion without counting a second send', () => {
  const value = new McpHttpTimingCollector('private-run', 'codex', 0, () => 1010)
  expect(value.accept({ ...start(), at: 1010 })).toBe(true)
  expect(value.accept({ ...begin(), at: 1010 })).toBe(true)
  expect(value.accept({ ...end(), at: 1010 })).toBe(true)
  expect(value.accept(event('request_body_end', 4, { request: 1, at: 1010, durationMs: 8.25, outcome: 'read' }))).toBe(true)
  expect(value.accept(event('child_close', 5, { at: 1010, sent: 1, completed: 1 }))).toBe(true)
  expect(value.finish()).toMatchObject({ version: 3, observedComplete: true, childLifecycleComplete: true,
    children: [{ sent: 1, completed: 1, lastSequence: 5 }],
    requests: [{ endedAt: 1010, durationMs: 3.25, status: 200, outcome: 'ok',
      body: { endedAt: 1010, durationMs: 8.25, outcome: 'read' } }] })
})

it('pairs concurrent physical sends by request id, without using receiver arrival as their start time', () => {
  let now = 1000
  const value = new McpHttpTimingCollector('private-run', 'codex', 0, () => now)
  expect(value.accept(start())).toBe(true)
  now = 1010
  expect(value.accept(begin())).toBe(true)
  expect(value.accept(event('request_start', 3, { request: 2, operation: 'decision_record', at: 1001 }))).toBe(true)
  expect(value.accept(event('request_end', 4, { request: 2, at: 1003, status: null, outcome: 'error', durationMs: 2.1 }))).toBe(true)
  expect(value.accept(event('request_end', 5, { request: 1, at: 1005, status: 200, outcome: 'ok', durationMs: 5.2 }))).toBe(true)
  expect(value.accept(event('child_close', 6, { sent: 2, completed: 2, at: 1006 }))).toBe(true)
  const receipt = value.finish()
  expect(receipt).toMatchObject({ runIdHash: runIdHash('private-run'), expectedChildren: 1, observedChildren: 1, closedChildren: 1,
    observedComplete: true, childLifecycleComplete: true, generationCoverage: 'unverified', allFirstPartyHttpComplete: false,
    requests: [{ child: 1, sequence: 1, startedAt: 1000, endedAt: 1005, outcome: 'ok' },
      { child: 1, sequence: 2, startedAt: 1001, endedAt: 1003, outcome: 'error' }],
    children: [{ child: 1, lastSequence: 6, sent: 2, completed: 2, lost: 0 }] })
  expect(JSON.stringify(receipt)).not.toMatch(/private-run|aaaaaaaa|Bearer|https?:/)
})

it.each([
  { outcome: ['read'] }, { outcome: 'ok' }, { durationMs: 1 }, { at: 999 },
  { content: 'PRIVATE_BODY' }, { request: 2 },
])('rejects malformed body completion without altering the observed physical send', fields => {
  const value = collector()
  value.accept(start()); value.accept(begin()); value.accept(end())
  expect(value.accept(event('request_body_end', 4, { request: 1, durationMs: 8, outcome: 'read', ...fields }))).toBe(false)
  const receipt = value.finish()
  expect(receipt).toMatchObject({ rejectedEvents: 1, observedComplete: false,
    children: [{ sent: 1, completed: 1, lastSequence: 3 }], requests: [{ body: null, durationMs: 3.25 }] })
  expect(JSON.stringify(receipt)).not.toContain('PRIVATE_BODY')
})

it('requires a response before body completion and never accepts it twice', () => {
  const value = collector()
  value.accept(start()); value.accept(begin())
  expect(value.accept(event('request_body_end', 3, { request: 1, durationMs: 8, outcome: 'read' }))).toBe(false)
  expect(value.accept(end())).toBe(true)
  expect(value.accept(event('request_body_end', 4, { request: 1, durationMs: 8, outcome: 'error' }))).toBe(true)
  expect(value.accept(event('request_body_end', 5, { request: 1, durationMs: 9, outcome: 'read' }))).toBe(false)
  expect(value.finish().requests[0]?.body).toEqual({ endedAt: 1000, durationMs: 8, outcome: 'error' })
})

it('does not infer lifecycle closure or unseen generations from paired requests, CLI exit, or no observed child', () => {
  expect(collector().finish()).toMatchObject({ observedChildren: 0, closedChildren: 0, observedComplete: false,
    childLifecycleComplete: false, generationCoverage: 'unverified', allFirstPartyHttpComplete: false })
  const value = collector()
  value.accept(start()); value.accept(begin()); value.accept(end())
  expect(value.finish()).toMatchObject({ observedComplete: true, childLifecycleComplete: false, closedChildren: 0,
    children: [{ closedAt: null }], generationCoverage: 'unverified', allFirstPartyHttpComplete: false })
})

it.each([
  event('request_start', 2, { request: 1, operation: { toString: 'private' } }),
  event('request_start', 2, { request: 1, operation: ['decision_catalogue'] }),
  event('request_start', 2, { request: 1, operation: 'permission_check' }),
  { ...begin(), args: 'PRIVATE_ARGUMENTS' },
  begin(4),
  event('child_close', 2, { sent: 1, completed: 1 }),
  event('request_end', 2, { request: 1, status: 200, outcome: 'ok', durationMs: 1 }),
])('rejects unknown fields, operations, gaps and unmatched lifecycle events without retaining their values', malformed => {
  const value = collector()
  value.accept(start())
  expect(value.accept(malformed)).toBe(false)
  const receipt = value.finish()
  expect(receipt).toMatchObject({ observedComplete: false, childLifecycleComplete: false, rejectedEvents: 1, requests: [] })
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|permission_check|toString/)
})

it('retains pending requests and known delivery loss without declaring received evidence complete', () => {
  const value = collector()
  value.accept(start()); value.accept({ ...begin(), lost: 1 })
  expect(value.finish()).toMatchObject({ observedComplete: false, childLifecycleComplete: false,
    children: [{ sent: 1, completed: 0, lost: 1 }], requests: [{ outcome: 'pending', endedAt: null, durationMs: null, status: null }] })
})

it('bounds both generation and request storage, marking overflow rather than silently dropping calls', () => {
  const children = collector()
  for (let i = 0; i < MCP_HTTP_CHILD_LIMIT; i++) expect(children.accept({ ...start(), child: i.toString(16).padStart(32, '0') })).toBe(true)
  expect(children.accept(start())).toBe(false)
  expect(children.finish()).toMatchObject({ observedChildren: MCP_HTTP_CHILD_LIMIT, truncated: true, observedComplete: false })
  const requests = collector()
  requests.accept(start())
  for (let i = 1; i <= MCP_HTTP_REQUEST_LIMIT; i++) {
    expect(requests.accept(begin(i * 2, i))).toBe(true)
    expect(requests.accept(end(i * 2 + 1, i))).toBe(true)
  }
  expect(requests.accept(begin(258, 129))).toBe(false)
  expect(requests.finish()).toMatchObject({ truncated: true, observedComplete: false,
    children: [{ sent: MCP_HTTP_REQUEST_LIMIT, completed: MCP_HTTP_REQUEST_LIMIT }] })
})

it('records the configured host remote MCP count and preserves host-only scope when child collection is disabled', () => {
  const runtime = new RunRuntimeTimings()
  const noChild = runtime.begin('no-child', 'device', 'codex').finish()!
  expect(noChild).toMatchObject({ complete: true, scope: 'daemon_http_server_link_and_task_fetch', allFirstPartyHttpComplete: false })
  expect(noChild).not.toHaveProperty('mcpHttpTiming')
  const observation = runtime.begin('private-run', 'device', 'codex')
  runtime.attachMcpHttpTiming('private-run', collector(2).finish())
  expect(observation.finish()?.mcpHttpTiming).toMatchObject({ remoteMcpServerCount: 2, childPathAuditVersion: 2 })
  expect(() => collector(-1)).toThrow('mcp_observation_scope_invalid')
})
