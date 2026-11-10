import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareMikkaMcpBridge } from '../src/agents/mikka-mcp-bridge'
import { prepareRunContextFiles, runMcpBackendContext } from '../src/agents/run-context'
import { runMcp } from '../src/agents/run-apps'

const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
const { Client } = sdkRequire('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = sdkRequire('@modelcontextprotocol/sdk/inMemory.js')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const catalogue = JSON.stringify({ version: 1, tool: { name: 'record_decision', title: 'Record decision', description: 'Fixture decision',
  inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'], additionalProperties: false },
  annotations: { idempotentHint: true } } })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-bridge-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const lifetime = new AbortController()
  return { root, config: { handoffFile: join(root, 'handoff.json') },
    authority: { signal: lifetime.signal, assertLive: () => lifetime.signal.throwIfAborted() }, lifetime }
}
async function connect(bridge: ReturnType<typeof prepareMikkaMcpBridge>) {
  const client = new Client({ name: 'real-sdk-ipc-fixture', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await bridge.server.instance.connect(a); await client.connect(b)
  cleanups.push(async () => { await client.close(); await bridge.server.instance.close(); await bridge.close() })
  return client
}
it('advertises the actual complete catalogue before binding and refuses every unbound call', async () => {
  const f = fixture(), bridge = prepareMikkaMcpBridge({ decisionCatalogue: catalogue, repositorySelection: true, captures: true, artifactInspection: true })
  const client = await connect(bridge)
  expect((await client.listTools()).tools).toEqual(bridge.tools())
  expect(bridge.tools().map(tool => tool.name)).toEqual(expect.arrayContaining(['record_decision', 'switch_repository', 'submit_capture', 'ask_human']))
  await expect(client.callTool({ name: 'ask_human', arguments: { question: 'no authority', kind: 'decision' } })).rejects.toThrow()
  expect(existsSync(f.config.handoffFile)).toBe(false)
})
it('binds once through a real isolated worker and uses the original handoff handler', async () => {
  const f = fixture(), bridge = prepareMikkaMcpBridge({})
  const client = await connect(bridge)
  await bridge.bind(f.config, f.authority)
  await client.callTool({ name: 'ask_human', arguments: { question: 'Choose one', kind: 'decision' } })
  expect(JSON.parse(readFileSync(f.config.handoffFile, 'utf8'))).toMatchObject({ kind: 'ask', question: { question: 'Choose one' } })
  await expect(bridge.bind(f.config, f.authority)).rejects.toThrow()
  f.lifetime.abort()
  await bridge.close()
  await expect(client.callTool({ name: 'ask_human', arguments: { question: 'after revocation', kind: 'decision' } })).rejects.toThrow()
  expect(JSON.parse(readFileSync(f.config.handoffFile, 'utf8')).question.question).toBe('Choose one')
})
it('failed context validation permanently consumes binding and drains its worker', async () => {
  const f = fixture(), bridge = prepareMikkaMcpBridge({ repositorySelection: true })
  await connect(bridge)
  await expect(bridge.bind({ ...f.config, repositoryRoot: join(f.root, 'missing') }, f.authority)).rejects.toThrow()
  expect(bridge.bound).toBe(false)
  await expect(bridge.bind(f.config, f.authority)).rejects.toThrow()
  await bridge.close()
})
it('revokes an in-flight business call without blocking the SDK event loop', async () => {
  const f = fixture(), bridge = prepareMikkaMcpBridge({ decisionCatalogue: catalogue })
  const client = await connect(bridge)
  let entered!: () => void, ended!: () => void
  const received = new Promise<void>(r => { entered = r }), disconnected = new Promise<void>(r => { ended = r })
  const server = createServer((request, response) => { request.resume(); response.on('close', ended); entered() })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise<void>(r => server.close(() => r())))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('fixture listener')
  await bridge.bind({ ...f.config, decisionCatalogue: catalogue, decisionUrl: `http://127.0.0.1:${address.port}/api/mcp`, decisionToken: 'mkw_' + 'A'.repeat(43) }, f.authority)
  const call = client.callTool({ name: 'record_decision', arguments: { idempotencyKey: 'held' } })
  void call.catch(() => undefined)
  await received
  f.lifetime.abort()
  await expect(call).rejects.toThrow()
  await bridge.close(); await disconnected
})
it('keeps a blocking Git handler outside the daemon loop and kills its owned process group', async () => {
  const f = fixture(), bin = join(f.root, 'bin'), marker = join(f.root, 'git-entered')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf entered > ' + marker + '\nsleep 30\n', { mode: 0o755 })
  const bridge = prepareMikkaMcpBridge({ repositorySelection: true }), client = await connect(bridge)
  await bridge.bind({ ...f.config, repositoryRoot: f.root, env: { ...process.env, PATH: bin + ':' + process.env.PATH, MARKER: marker } }, f.authority)
  const call = client.callTool({ name: 'switch_repository', arguments: { repository: 'fixture/other', reason: 'fixture' } })
  void call.catch(() => undefined)
  // Bounded local fixture observation, never an application/server poll.
  const deadline = Date.now() + 3000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  expect(existsSync(marker)).toBe(true)
  let advanced = false
  await new Promise<void>(r => setImmediate(() => { advanced = true; r() }))
  expect(advanced).toBe(true)
  f.lifetime.abort()
  await expect(call).rejects.toThrow()
  await bridge.close()
}, 10000)

const firstParent = '00-11111111111111111111111111111111-1111111111111111-01'
const secondParent = '00-22222222222222222222222222222222-2222222222222222-00'
async function tracedBridge(parent?: string) {
  const f = fixture(), requests: { traceparent?: string; authorization?: string; baggage?: string; params: unknown }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ traceparent: request.headers.traceparent as string | undefined, authorization: request.headers.authorization,
      baggage: request.headers.baggage as string | undefined, params: body.params })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'recorded' }] },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('fixture listener')
  const options = { harness: 'claude_code' as const, worktree: f.root, runDir: join(f.root, 'run'), privateDir: f.root,
    mcp: runMcp({ url: `http://127.0.0.1:${address.port}/api/mcp`, token: 'mkw_' + 'A'.repeat(43),
      decisionCatalogue: JSON.parse(catalogue) }, parent ? { traceparent: parent } : undefined) }
  const files = prepareRunContextFiles(options)
  const context = runMcpBackendContext(options, files, { PATH: process.env.PATH, MIKKA_DECISION_MCP_TRACEPARENT: secondParent })
  const bridge = prepareMikkaMcpBridge({ captures: true, decisionCatalogue: catalogue }), client = await connect(bridge)
  return { ...f, bridge, client, context, requests }
}

it('late-bound SDK workers keep distinct captured parents and cannot rebind to another run', async () => {
  const first = await tracedBridge(firstParent), second = await tracedBridge(secondParent)
  // Catalogue preparation carries no run authority and makes no business call.
  await first.client.listTools()
  expect(first.requests).toEqual([])
  await first.bridge.bind(first.context, first.authority)
  await second.bridge.bind(second.context, second.authority)
  first.context.decisionTraceparent = secondParent
  const input = { idempotencyKey: 'bound-run', traceparent: secondParent, baggage: 'private-canary' }
  await first.client.callTool({ name: 'record_decision', arguments: input })
  await second.client.callTool({ name: 'record_decision', arguments: { idempotencyKey: 'other-run' } })
  expect(first.requests.map(request => request.traceparent)).toEqual([firstParent])
  expect(second.requests.map(request => request.traceparent)).toEqual([secondParent])
  expect(first.requests[0].params).toEqual({ name: 'record_decision', arguments: input })
  expect([...first.requests, ...second.requests].every(request => request.authorization === 'Bearer mkw_' + 'A'.repeat(43) && request.baggage === undefined)).toBe(true)
  await expect(first.bridge.bind(second.context, second.authority)).rejects.toThrow()
  first.lifetime.abort()
  await expect(first.client.callTool({ name: 'record_decision', arguments: { idempotencyKey: 'revoked' } })).rejects.toThrow()
  expect(first.requests).toHaveLength(1)
})

it.each(['missing', 'malformed', 'zero-trace', 'zero-parent', 'newline', 'flags-width', 'flags-case'] as const)('the SDK backend drops a %s carrier while preserving business authority', async kind => {
  const f = await tracedBridge()
  // Exercise the child boundary independently of the host sanitizer.
  f.context.decisionTraceparent = kind === 'missing' ? undefined : kind === 'malformed' ? 'private-canary'
    : kind === 'newline' ? firstParent + '\r\nprivate-canary: x'
      : kind === 'flags-width' ? firstParent.slice(0, -2) + '001'
        : kind === 'flags-case' ? firstParent.slice(0, -2) + 'FF'
    : kind === 'zero-trace' ? '00-' + '0'.repeat(32) + '-1111111111111111-01'
      : '00-' + '1'.repeat(32) + '-' + '0'.repeat(16) + '-01'
  await f.bridge.bind(f.context, f.authority)
  const reply = await f.client.callTool({ name: 'record_decision', arguments: { idempotencyKey: 'without-parent', traceparent: firstParent } })
  expect(reply.isError).not.toBe(true)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].traceparent).toBeUndefined()
  expect(f.requests[0].authorization).toBe('Bearer mkw_' + 'A'.repeat(43))
})
