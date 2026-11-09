import { afterEach, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MCP_SERVER_SCRIPT, prepareRunContextFiles } from '../src/agents/run-context'
import type { RunTraceContext } from '@mikka/protocol/trace-context'
import { runMcp } from '../src/agents/run-apps'

type Result = { tools?: { name: string; inputSchema: unknown }[]; content?: { type: string; text: string }[]; isError?: boolean }
type Reply = { id: number; result?: Result; error?: { code: number; message: string } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const token = 'mkw_' + 'A'.repeat(43)
const schema = { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'], additionalProperties: false }

async function fixture(authority = true, tracing?: { carrier?: RunTraceContext; inherited?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-decision-'))
  const requests: { authorization?: string; traceparent?: string; baggage?: string; method: string; params: { name?: string; arguments?: unknown } }[] = []
  let denied = false, writes = 0
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ authorization: incoming.headers.authorization, traceparent: incoming.headers.traceparent as string | undefined,
      baggage: incoming.headers.baggage as string | undefined, method: request.method, params: request.params })
    if (denied) { outgoing.writeHead(401); outgoing.end('not authorized'); return }
    const result = request.method === 'tools/list'
      ? { tools: [{ name: 'record_decision', inputSchema: schema }, { name: 'report', inputSchema: schema }] }
      : { content: [{ type: 'text', text: JSON.stringify({ decisionId: 'server-record', duplicate: writes++ > 0 }) }] }
    if (request.method === 'tools/list') {
      outgoing.setHeader('content-type', 'application/json')
      outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    } else {
      outgoing.setHeader('content-type', 'text/event-stream')
      outgoing.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n\n')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('test server unavailable')
  const url = 'http://127.0.0.1:' + address.port + '/mikka/api/mcp'
  const spec = tracing ? prepareRunContextFiles({ harness: 'codex', worktree: directory,
    runDir: join(directory, 'run'), privateDir: directory,
    mcp: authority ? runMcp({ url, token }, tracing.carrier) : undefined }).mcpServer() : {
    command: process.execPath, args: [MCP_SERVER_SCRIPT, '--handoff', join(directory, 'handoff.json')],
    env: authority ? { MIKKA_DECISION_MCP_URL: url, MIKKA_DECISION_MCP_TOKEN: token } : {},
  }
  const child = spawn(spec.command, spec.args, {
    env: { PATH: process.env.PATH, MIKKA_DECISION_MCP_TRACEPARENT: tracing?.inherited, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (value: Reply) => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const message: Reply = JSON.parse(line); pending.get(message.id)?.(message) })
  let next = 0
  const call = (method: string, params: unknown = {}) => new Promise<Reply>((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('stdio response timed out')) }, 10_000)
    pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  cleanups.push(async () => {
    child.kill()
    lines.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  return { call, requests, directory, deny: () => { denied = true } }
}

test('stdio gets the canonical worker schema and records directly, preserving exact retries without a handoff file', async () => {
  const f = await fixture()
  const listed = await f.call('tools/list')
  expect(listed.result?.tools?.find(tool => tool.name === 'record_decision')?.inputSchema).toEqual(schema)
  expect(listed.result?.tools?.some(tool => tool.name === 'report')).toBe(false)
  const input = { kind: 'confirm', title: 'Choose the existing route', summary: 'Keep the existing route', reason: 'It meets the task constraints', idempotencyKey: 'decision-test-1' }
  const first = await f.call('tools/call', { name: 'record_decision', arguments: input })
  const second = await f.call('tools/call', { name: 'record_decision', arguments: input })
  expect(JSON.parse(first.result!.content![0].text)).toEqual({ decisionId: 'server-record', duplicate: false })
  expect(JSON.parse(second.result!.content![0].text)).toEqual({ decisionId: 'server-record', duplicate: true })
  expect(f.requests.map(request => request.method)).toEqual(['tools/list', 'tools/call', 'tools/call'])
  expect(f.requests.every(request => request.authorization === 'Bearer ' + token)).toBe(true)
  expect(f.requests[1].params).toEqual({ name: 'record_decision', arguments: input })
  expect(readdirSync(f.directory)).toEqual([])
})

test('stdio reports revoked authority without falling back to repository storage', async () => {
  const f = await fixture()
  await f.call('tools/list')
  f.deny()
  const reply = await f.call('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'same-key' } })
  expect(reply.result?.isError).toBe(true)
  expect(JSON.stringify(reply)).not.toContain(token)
  expect(readdirSync(f.directory)).toEqual([])
})

test('an unbound local stdio server does not advertise or execute a decision writer', async () => {
  const f = await fixture(false)
  expect((await f.call('tools/list')).result?.tools?.some(tool => tool.name === 'record_decision')).toBe(false)
  expect((await f.call('tools/call', { name: 'record_decision', arguments: {} })).error?.code).toBe(-32602)
  expect(f.requests).toEqual([])
  expect(readdirSync(f.directory)).toEqual([])
})

test('claimed task MCP authority exists without app connections and rejects generic OAuth or untrusted URLs', () => {
  const mcp = { url: 'https://mikka.example/mikka/api/mcp', token, apps: [] }
  expect(runMcp(mcp)).toEqual({ url: mcp.url, token })
  expect(runMcp(undefined)).toBeUndefined()
  expect(runMcp({ ...mcp, token: 'mka_external' })).toBeUndefined()
  expect(runMcp({ ...mcp, url: 'http://mikka.example/mikka/api/mcp' })).toBeUndefined()
  expect(runMcp({ ...mcp, url: 'https://user:password@mikka.example/mikka/api/mcp' })).toBeUndefined()
  expect(runMcp({ ...mcp, url: 'https://mikka.example/api/other' })).toBeUndefined()
})

const firstParent = '00-11111111111111111111111111111111-1111111111111111-01'
const secondParent = '00-22222222222222222222222222222222-2222222222222222-00'

test('stdio carries only its captured run parent through catalogue and record requests', async () => {
  const carrier = { traceparent: firstParent }
  const first = await fixture(true, { carrier, inherited: secondParent })
  const second = await fixture(true, { carrier: { traceparent: secondParent }, inherited: firstParent })
  carrier.traceparent = secondParent
  const input = { idempotencyKey: 'trace-fixture', traceparent: secondParent, baggage: 'private-canary' }
  await Promise.all([first.call('tools/list'), second.call('tools/list')])
  await first.call('tools/call', { name: 'record_decision', arguments: input })
  await second.call('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'other-run' } })
  expect(first.requests.map(request => request.traceparent)).toEqual([firstParent, firstParent])
  expect(second.requests.map(request => request.traceparent)).toEqual([secondParent, secondParent])
  expect([...first.requests, ...second.requests].every(request => request.authorization === 'Bearer ' + token && request.baggage === undefined)).toBe(true)
  expect(first.requests[1].params.arguments).toEqual(input)
})

test.each([
  ['missing', undefined],
  ['malformed', { traceparent: 'private-canary' }],
  ['zero-trace', { traceparent: '00-' + '0'.repeat(32) + '-1111111111111111-01' }],
  ['zero-parent', { traceparent: '00-' + '1'.repeat(32) + '-' + '0'.repeat(16) + '-01' }],
  ['newline', { traceparent: firstParent + '\r\nprivate-canary: x' }],
  ['flags-width', { traceparent: firstParent.slice(0, -2) + '001' }],
  ['flags-case', { traceparent: firstParent.slice(0, -2) + 'FF' }],
] as const)('stdio drops a %s carrier without inheriting another run or rejecting business work', async (_kind, carrier) => {
  const f = await fixture(true, { carrier, inherited: secondParent })
  await f.call('tools/list')
  const reply = await f.call('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'no-trace', traceparent: firstParent } })
  expect(reply.result?.isError).not.toBe(true)
  expect(f.requests).toHaveLength(2)
  expect(f.requests.every(request => request.traceparent === undefined && request.authorization === 'Bearer ' + token)).toBe(true)
})

test('the host ignores assignment telemetry and a trace carrier never supplies task authority', async () => {
  const mcp = { url: 'https://mikka.example/mikka/api/mcp', token, traceparent: secondParent }
  expect(runMcp(mcp)).toEqual({ url: mcp.url, token })
  expect(runMcp(mcp, { traceparent: firstParent, runId: 'opaque-run', sessionId: 'opaque-session' }))
    .toEqual({ url: mcp.url, token, traceparent: firstParent })
  const f = await fixture(false, { carrier: { traceparent: firstParent }, inherited: secondParent })
  expect((await f.call('tools/list')).result?.tools?.some(tool => tool.name === 'record_decision')).toBe(false)
  expect((await f.call('tools/call', { name: 'record_decision', arguments: {} })).error?.code).toBe(-32602)
  expect(f.requests).toEqual([])
})
