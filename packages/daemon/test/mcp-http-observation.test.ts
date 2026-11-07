import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it, vi } from 'vitest'
import { MCP_SERVER_SCRIPT, RunContext } from '../src/agents/run-context'
import { McpHttpTimingCollector } from '../src/mcp-http-timing'
import { startCliTimingCollector } from '../src/official-cli-timing'
import { runRuntimeTimings } from '../src/run-runtime-timing'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

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

function client(url: string, observationUrl: string) {
  const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, '--handoff', join(tempDir(), 'handoff.json')], {
    env: { PATH: process.env.PATH, MIKKA_DECISION_MCP_URL: url, MIKKA_DECISION_MCP_TOKEN: syntheticToken,
      MIKKA_MCP_HTTP_OBSERVATION_URL: observationUrl }, stdio: ['pipe', 'pipe', 'pipe'],
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
    for (const pending of waiting.values()) pending.reject(new Error('MCP child closed'))
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
      allFirstPartyHttpComplete: false, generationCoverage: 'unverified', remoteMcpServerCount: 0, childPathAuditVersion: 1 })
    expect(receipt.requests.map(request => [request.operation, request.status, request.outcome])).toEqual([
      ['decision_catalogue', 200, 'ok'], ['decision_record', 200, 'ok'],
    ])
    expect(receipt.requests.every(request => request.durationMs! >= 0 && request.endedAt! >= request.startedAt)).toBe(true)
    expect(receipt.closedChildren).toBe(observed.events.filter(event => event.type === 'child_close').length)
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|mkw_|127\.0\.0\.1|arguments|content|authorization/)
  } finally { await mcp.close(); await receiver.close(); run.close(); await api.close() }
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
      requests: [{ operation: 'decision_record', outcome: 'error', status: failure === 'http_error' ? 503 : null }] })
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
  const ctx = new RunContext({ harness, worktree: await makeRepo(), runDir: tempDir(), privateDir: tempDir(), machineEnvironment: true,
    mcp: { url: 'https://mikka.example.invalid/api/mcp', token: syntheticToken }, mcpHttpObservationUrl: url })
  expect(ctx.mcpServer().env.MIKKA_MCP_HTTP_OBSERVATION_URL).toBe(url)
  expect(ctx.decisionMcpEnv()).not.toHaveProperty('MIKKA_MCP_HTTP_OBSERVATION_URL')
  expect(ctx.tempEnv()).not.toHaveProperty('MIKKA_MCP_HTTP_OBSERVATION_URL')
})
