import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, renameSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it, vi } from 'vitest'
import { MCP_SERVER_SCRIPT, prepareRunContextFiles, RunContext, type RunContextOptions, type McpServerSpec } from '../src/agents/run-context'
import { McpHttpTimingCollector } from '../src/mcp-http-timing'
import { startCliTimingCollector } from '../src/official-cli-timing'
import { runRuntimeTimings } from '../src/run-runtime-timing'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'
import { writeCodexMcpContext } from '../src/codex-mcp-context'
import { readMcpContext } from '../src/agents/mikka-mcp-context.mjs'
import { runDecisionCatalogueSchema } from '@mikka/protocol'

// Load the real app claim catalogue without pulling app-only type aliases into the daemon typecheck.
const claimCatalogueModule = await import(new URL('../../../lib/project-map/mcp-tool.ts', import.meta.url).href)
const RUN_DECISION_CATALOGUE = runDecisionCatalogueSchema.parse(claimCatalogueModule.RUN_DECISION_CATALOGUE)

afterEach(() => { vi.restoreAllMocks(); cleanupTempDirs() })
type Rpc = { jsonrpc: string; id: number; method: string; params?: { name?: string; arguments?: unknown } }
const syntheticToken = `mkw_${'x'.repeat(43)}`

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function backend(respond?: (rpc: Rpc, response: ServerResponse) => void) {
  const calls: Rpc[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc
      calls.push(rpc)
      if (respond) return respond(rpc, response)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
        result: rpc.method === 'tools/list' ? { tools: [{ name: 'record_decision', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_RESPONSE' }] } }))
    })().catch(() => response.writeHead(500).end())
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/PRIVATE_PATH`, calls,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}

function client(url: string, observationUrl: string, extraEnv: Record<string, string> = {}, server?: McpServerSpec) {
  const child = spawn(server?.command ?? process.execPath, server?.args ?? [MCP_SERVER_SCRIPT, '--handoff', join(tempDir(), 'handoff.json')], {
    env: server ? { PATH: process.env.PATH, ...extraEnv, ...server.env } : { PATH: process.env.PATH, MIKKA_DECISION_MCP_URL: url, MIKKA_DECISION_MCP_TOKEN: syntheticToken,
      MIKKA_MCP_HTTP_OBSERVATION_URL: observationUrl, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map<number, ReturnType<typeof deferred<Record<string, unknown>>>>()
  const closing = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as { id: number }
    waiting.get(message.id)?.resolve(message); waiting.delete(message.id)
  })
  child.once('error', closing.reject)
  child.once('close', (code, signal) => {
    closing.resolve({ code, signal })
    for (const pending of waiting.values()) pending.reject(new Error('MCP child closed: ' + code))
    waiting.clear()
  })
  child.stderr.resume()
  let id = 0
  return { child, closed: closing.promise,
    request(method: string, params?: unknown) {
      const current = ++id, result = deferred<Record<string, unknown>>()
      waiting.set(current, result)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
      return result.promise
    },
    close: async () => { child.kill('SIGKILL'); await closing.promise },
  }
}

const preparedCatalogue = { version: 1, tool: { name: 'record_decision', title: 'Record a project decision',
  description: 'Canonical claim catalogue fixture.', inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'] },
  annotations: { idempotentHint: true } } } as const

it('uses the prepared canonical catalogue without a startup HTTP request and preserves the real decision write', async () => {
  const api = await backend()
  const mcp = client(api.url, '', { MIKKA_DECISION_MCP_CATALOGUE: JSON.stringify(preparedCatalogue) })
  try {
    const listed = await mcp.request('tools/list')
    expect(listed).toMatchObject({ result: { tools: expect.arrayContaining([preparedCatalogue.tool]) } })
    await mcp.request('tools/list')
    expect(api.calls).toEqual([])
    await mcp.request('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'same-business-write' } })
    expect(api.calls.map(call => [call.method, call.params?.name])).toEqual([['tools/call', 'record_decision']])
  } finally { await mcp.close(); await api.close() }
})

it('observes the exact prepared catalogue separately from physical HTTP without retaining its contents', async () => {
  const api = await backend(), observed = receivedEvents(), runId = randomUUID()
  const run = runRuntimeTimings.begin(runId, 'device', 'codex')
  const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0, decisionCatalogue: preparedCatalogue })
  const serialized = JSON.stringify(preparedCatalogue)
  const mcp = client(api.url, receiver.mcpHttpObservationUrl, { MIKKA_DECISION_MCP_CATALOGUE: serialized })
  try {
    await Promise.all([mcp.request('tools/list'), mcp.request('tools/list')])
    await observed.until(events => events.some(event => event.type === 'catalogue_ready'))
    expect(api.calls).toEqual([])
    expect(observed.events.filter(event => event.type === 'catalogue_ready')).toHaveLength(1)
    await mcp.request('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'PRIVATE_KEY' } })
    await observed.until(events => events.some(event => event.type === 'request_body_end'))
    await mcp.close(); await receiver.close()
    const receipt = run.finish()!.mcpHttpTiming!
    expect(receipt).toMatchObject({ version: 3, expectedCatalogueSha256: createHash('sha256').update(serialized).digest('hex'),
      observedComplete: true, children: [{ sent: 1, completed: 1, catalogue: { source: 'claim' } }],
      requests: [{ operation: 'decision_record', body: { outcome: 'read' } }] })
    expect(receipt.requests).toHaveLength(1)
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|Canonical claim|inputSchema|mkw_|127\.0\.0\.1/)
  } finally { await mcp.close(); await receiver.close(); run.close(); await api.close() }
})

it.each(['not-json', JSON.stringify({ ...preparedCatalogue, version: 2 }),
  JSON.stringify({ ...preparedCatalogue, tool: { ...preparedCatalogue.tool, name: 'arbitrary_tool' } }),
  JSON.stringify({ ...preparedCatalogue, extra: 'unexpected' })])('does not fetch a replacement for an invalid prepared catalogue', async catalogue => {
  const api = await backend()
  const mcp = client(api.url, '', { MIKKA_DECISION_MCP_CATALOGUE: catalogue })
  try {
    const listed = await mcp.request('tools/list') as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.some(tool => tool.name === 'record_decision')).toBe(false)
    expect(api.calls).toEqual([])
  } finally { await mcp.close(); await api.close() }
})

/** Observe the real receiver's accepted events without replacing its parser,
 * transport or state. Tests wait on actual delivery, never a sleep/poll loop. */
function receivedEvents(rejectFirst = false) {
  const events: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  const accept = McpHttpTimingCollector.prototype.accept
  let first = true
  vi.spyOn(McpHttpTimingCollector.prototype, 'accept').mockImplementation(function (this: McpHttpTimingCollector, input) {
    if (rejectFirst && first) { first = false; this.reject(); return false }
    const accepted = accept.call(this, input)
    if (accepted) { events.push(input as Record<string, unknown>); for (const notify of waiters) notify() }
    return accepted
  })
  return { events, until: (predicate: (events: Record<string, unknown>[]) => boolean) => new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const done = () => { if (predicate(events)) { clearTimeout(timer); waiters.delete(done); resolve() } }
    timer = setTimeout(() => { waiters.delete(done); reject(new Error('Expected MCP observation did not arrive')) }, 3000)
    waiters.add(done); done()
  }) }
}

it('observes the real MCP child catalogue and decision fetches, preserving cache and business contents without retaining them', async () => {
  const api = await backend(), observed = receivedEvents(), runId = randomUUID()
  const run = runRuntimeTimings.begin(runId, 'device', 'codex')
  const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0 })
  const mcp = client(api.url, receiver.mcpHttpObservationUrl)
  try {
    expect(new URL(receiver.mcpHttpObservationUrl).origin).toBe(new URL(receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).origin)
    expect(JSON.stringify(receiver.env)).not.toContain('/v1/mcp-http/')
    const [catalogue] = await Promise.all([mcp.request('tools/list'), mcp.request('tools/list')])
    expect(catalogue).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'record_decision' })]) } })
    await mcp.request('tools/list')
    const result = await mcp.request('tools/call', { name: 'record_decision', arguments: { private: 'PRIVATE_SYNTHETIC_ARGUMENT' } })
    expect(result).toMatchObject({ result: { content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_RESPONSE' }] } })
    await observed.until(events => events.filter(event => event.type === 'request_end').length === 2)
    expect(api.calls.map(call => [call.method, call.params?.name])).toEqual([['tools/list', undefined], ['tools/call', 'record_decision']])
    await mcp.request('tools/call', { name: 'unrecognized_remote_tool', arguments: {} })
    expect(api.calls).toHaveLength(2)
    mcp.child.stdin.end()
    expect(await mcp.closed).toEqual({ code: 0, signal: null })
    await receiver.close({ cliExitObserved: true })
    const receipt = run.finish()!.mcpHttpTiming!
    expect(receipt).toMatchObject({ observedChildren: 1, observedComplete: true, rejectedEvents: 0, truncated: false,
      allFirstPartyHttpComplete: false, generationCoverage: 'unverified', remoteMcpServerCount: 0, childPathAuditVersion: 2 })
    expect(receipt.requests.map(request => [request.operation, request.status, request.outcome])).toEqual([
      ['decision_catalogue', 200, 'ok'], ['decision_record', 200, 'ok'],
    ])
    expect(receipt.requests.every(request => request.durationMs! >= 0 && request.endedAt! >= request.startedAt)).toBe(true)
    expect(receipt.closedChildren).toBe(observed.events.filter(event => event.type === 'child_close').length)
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|mkw_|127\.0\.0\.1|arguments|content|authorization/)
  } finally { await mcp.close(); await receiver.close(); run.close(); await api.close() }
})

it('records headers before a held response body and measures the real body completion without another business send', async () => {
  const releaseBody = deferred<void>()
  const api = await backend((rpc, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders()
    void releaseBody.promise.then(() => response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
      result: { tools: [{ name: 'record_decision', inputSchema: { type: 'object' } }] } })))
  })
  const observed = receivedEvents(), runId = randomUUID(), run = runRuntimeTimings.begin(runId, 'device', 'codex')
  const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0 })
  const mcp = client(api.url, receiver.mcpHttpObservationUrl)
  let replied = false
  const response = mcp.request('tools/list').then(value => { replied = true; return value })
  // Attach a rejection observer before assertions so cleanup cannot leave a
  // rejected child promise behind when the real socket fixture fails.
  void response.catch(() => {})
  try {
    await observed.until(events => events.some(event => event.type === 'request_end'))
    expect(replied).toBe(false)
    expect(observed.events.some(event => event.type === 'request_body_end')).toBe(false)
    releaseBody.resolve()
    expect(await response).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'record_decision' })]) } })
    await observed.until(events => events.some(event => event.type === 'request_body_end'))
    await mcp.close(); await receiver.close()
    const receipt = run.finish()!.mcpHttpTiming!, request = receipt.requests[0]!
    expect(api.calls).toHaveLength(1)
    expect(receipt).toMatchObject({ version: 3, observedComplete: true,
      children: [{ sent: 1, completed: 1 }], requests: [{ outcome: 'ok', status: 200, body: { outcome: 'read' } }] })
    expect(request.body!.durationMs).toBeGreaterThan(request.durationMs!)
    expect(request.body!.endedAt).toBeGreaterThanOrEqual(request.endedAt!)
  } finally { releaseBody.resolve(); await mcp.close(); await receiver.close(); run.close(); await api.close() }
})

it.each(['http_error', 'connection_error'] as const)('records a real %s at the physical send without changing the fixed business error', async failure => {
  const api = await backend((_rpc, response) => failure === 'http_error' ? response.writeHead(503).end('PRIVATE_ERROR') : response.destroy())
  const observed = receivedEvents(), runId = randomUUID(), run = runRuntimeTimings.begin(runId, 'device', 'codex')
  const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0 })
  const mcp = client(api.url, receiver.mcpHttpObservationUrl)
  try {
    const response = await mcp.request('tools/call', { name: 'record_decision', arguments: {} })
    expect(response).toMatchObject({ result: { isError: true } })
    expect(JSON.stringify(response)).not.toContain('PRIVATE_ERROR')
    await observed.until(events => events.some(event => event.type === 'request_end'))
    await mcp.close(); await receiver.close()
    expect(run.finish()!.mcpHttpTiming).toMatchObject({ observedComplete: true, childLifecycleComplete: false,
      requests: [{ operation: 'decision_record', outcome: 'error', status: failure === 'http_error' ? 503 : null, body: null }] })
    expect(api.calls).toHaveLength(1)
  } finally { await mcp.close(); await receiver.close(); run.close(); await api.close() }
})

it.each(['closed', 'invalid'] as const)('keeps business success and HTTP failure behavior unchanged when the observer URL is %s', async kind => {
  const api = await backend((rpc, response) => {
    if (rpc.method === 'tools/list') response.writeHead(503).end('PRIVATE_FAILURE')
    else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
      result: { content: [{ type: 'text', text: 'recorded' }] } }))
  })
  const receiver = await startCliTimingCollector({ runId: randomUUID(), harness: 'codex', remoteMcpServerCount: 0 })
  await receiver.close()
  const mcp = client(api.url, kind === 'closed' ? receiver.mcpHttpObservationUrl : 'https://private.invalid/never-requested')
  try {
    expect(await mcp.request('tools/list')).toMatchObject({ result: { tools: expect.any(Array) } })
    expect(await mcp.request('tools/call', { name: 'record_decision', arguments: {} }))
      .toMatchObject({ result: { content: [{ type: 'text', text: 'recorded' }] } })
    await mcp.request('tools/list') // A failed catalogue still retries as before.
    expect(api.calls.map(call => call.method)).toEqual(['tools/list', 'tools/call', 'tools/list'])
  } finally { await mcp.close(); await api.close() }
})

it('makes observer rejection unavailable evidence while the same real child still completes its business request', async () => {
  const api = await backend(), observed = receivedEvents(true), runId = randomUUID()
  const run = runRuntimeTimings.begin(runId, 'device', 'claude_code')
  const receiver = await startCliTimingCollector({ runId, harness: 'claude_code', remoteMcpServerCount: 0 })
  const mcp = client(api.url, receiver.mcpHttpObservationUrl)
  try {
    expect(await mcp.request('tools/list')).toMatchObject({ result: { tools: expect.any(Array) } })
    // A second business send does not depend on the observer's rejected start.
    expect(await mcp.request('tools/call', { name: 'record_decision', arguments: {} })).toMatchObject({ result: { content: expect.any(Array) } })
    await mcp.close(); await receiver.close()
    const receipt = run.finish()!.mcpHttpTiming!
    expect(api.calls).toHaveLength(2)
    expect(observed.events).toHaveLength(0)
    expect(receipt).toMatchObject({ observedComplete: false, childLifecycleComplete: false, observedChildren: 0 })
    expect(receipt.rejectedEvents).toBeGreaterThan(0)
  } finally { await mcp.close(); await receiver.close(); run.close(); await api.close() }
})

it('preserves immediate SIGTERM and reports an in-flight fetch as pending without fabricating child termination', async () => {
  const entered = deferred<void>(), observed = receivedEvents(), runId = randomUUID()
  const api = await backend(() => entered.resolve())
  const run = runRuntimeTimings.begin(runId, 'device', 'codex')
  const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0 })
  const mcp = client(api.url, receiver.mcpHttpObservationUrl)
  const request = mcp.request('tools/list')
  const stopped = expect(request).rejects.toThrow('MCP child closed')
  try {
    await entered.promise
    await observed.until(events => events.some(event => event.type === 'request_start'))
    mcp.child.kill('SIGTERM')
    expect((await mcp.closed).signal).toBe('SIGTERM')
    await stopped; await receiver.close({ cliExitObserved: true })
    expect(run.finish()!.mcpHttpTiming).toMatchObject({ observedChildren: 1, closedChildren: 0,
      observedComplete: false, childLifecycleComplete: false, requests: [{ outcome: 'pending', endedAt: null, durationMs: null }],
      generationCoverage: 'unverified', allFirstPartyHttpComplete: false })
  } finally { await mcp.close(); await stopped; await receiver.close(); run.close(); await api.close() }
})

it.each(['claude_code', 'codex'] as const)('puts the host observation URL only in the %s Mikka MCP child environment', async harness => {
  const url = `http://127.0.0.1:43210/v1/mcp-http/${'a'.repeat(32)}`
  const worktree = join(realpathSync(tempDir()), 'checkout')
  const options: RunContextOptions = { harness, worktree, runDir: tempDir(), privateDir: tempDir(), machineEnvironment: true,
    mcp: { url: 'https://mikka.example.invalid/api/mcp', token: syntheticToken, decisionCatalogue: preparedCatalogue }, mcpHttpObservationUrl: url }
  const early = prepareRunContextFiles(options)
  expect(existsSync(worktree)).toBe(false)
  renameSync(await makeRepo(), worktree)
  const ctx = new RunContext(options)
  expect(early.mcpServer()).toEqual(ctx.mcpServer())
  expect(ctx.mcpServer().env.MIKKA_MCP_HTTP_OBSERVATION_URL).toBe(url)
  expect(ctx.decisionMcpEnv()).not.toHaveProperty('MIKKA_MCP_HTTP_OBSERVATION_URL')
  expect(ctx.tempEnv()).not.toHaveProperty('MIKKA_MCP_HTTP_OBSERVATION_URL')
  expect(ctx.decisionMcpEnv().MIKKA_DECISION_MCP_CATALOGUE).toBe(JSON.stringify(preparedCatalogue))
  expect(ctx.mcpServer().env.MIKKA_DECISION_MCP_CATALOGUE).toBe(JSON.stringify(preparedCatalogue))
  expect(ctx.tempEnv()).not.toHaveProperty('MIKKA_DECISION_MCP_CATALOGUE')
  expect(ctx.mcpServer().args.join(' ')).not.toContain('Canonical claim')
})

it.each(['00-11111111111111111111111111111111-2222222222222222-01', undefined])(
  'passes the real run trace carrier %s through the late wrapper and observes the exact claim catalogue',
  async traceparent => {
    const api = await backend(), observed = receivedEvents(), runId = randomUUID()
    const run = runRuntimeTimings.begin(runId, 'device', 'codex')
    const receiver = await startCliTimingCollector({ runId, harness: 'codex', remoteMcpServerCount: 0, decisionCatalogue: RUN_DECISION_CATALOGUE })
    const privateDir = tempDir()
    const ctx = new RunContext({ harness: 'codex', worktree: await makeRepo(), runDir: tempDir(), privateDir,
      machineEnvironment: true, mcpHttpObservationUrl: receiver.mcpHttpObservationUrl,
      mcp: { url: api.url, token: syntheticToken, decisionCatalogue: RUN_DECISION_CATALOGUE, ...(traceparent ? { traceparent } : {}) } })
    const spec = ctx.mcpServer()
    expect(spec.env).toHaveProperty('MIKKA_DECISION_MCP_TRACEPARENT', traceparent ?? '')
    const bound = writeCodexMcpContext(privateDir, runId, spec)
    expect(JSON.stringify(bound.server)).not.toContain(syntheticToken)
    const mcp = client('', '', { MIKKA_DECISION_MCP_TRACEPARENT: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' }, bound.server)
    try {
      const listed = await mcp.request('tools/list')
      expect(listed).toMatchObject({ result: { tools: expect.arrayContaining([RUN_DECISION_CATALOGUE.tool]) } })
      await observed.until(events => events.some(event => event.type === 'catalogue_ready'))
      expect(readMcpContext(...bound.server.args.slice(1) as [string, string, string]).env).toEqual(spec.env)
      expect(api.calls).toEqual([])
      await mcp.close(); await receiver.close()
      const receipt = run.finish()!.mcpHttpTiming!
      const sha256 = createHash('sha256').update(JSON.stringify(RUN_DECISION_CATALOGUE)).digest('hex')
      expect(receipt).toMatchObject({ version: 3, expectedCatalogueSha256: sha256, observedChildren: 1,
        rejectedEvents: 0, truncated: false, children: [{ catalogue: { source: 'claim', sha256 } }], requests: [] })
      expect(JSON.stringify(receipt)).not.toContain(syntheticToken)
    } finally { await mcp.close(); await receiver.close(); run.close(); bound.close(); await api.close() }
  })
