import { afterEach, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MCP_SERVER_SCRIPT } from '../src/agents/run-context'
import { runMcp } from '../src/agents/run-apps'

type Result = { tools?: { name: string; inputSchema: unknown }[]; content?: { type: string; text: string }[]; isError?: boolean }
type Reply = { id: number; result?: Result; error?: { code: number; message: string } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const token = 'mkw_' + 'A'.repeat(43)
const schema = { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'], additionalProperties: false }

async function fixture(authority = true) {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-decision-'))
  const requests: { authorization?: string; method: string; params: { name?: string; arguments?: unknown } }[] = []
  let denied = false, writes = 0
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ authorization: incoming.headers.authorization, method: request.method, params: request.params })
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
  const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, '--handoff', join(directory, 'handoff.json')], {
    env: { PATH: process.env.PATH, ...(authority ? { MIKKA_DECISION_MCP_URL: 'http://127.0.0.1:' + address.port + '/mikka/api/mcp', MIKKA_DECISION_MCP_TOKEN: token } : {}) },
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
