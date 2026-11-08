import { afterEach, expect, it } from 'vitest'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mikkaMcpToolCatalogue, prepareMikkaMcpBackend } from '../src/agents/mikka-mcp-backend.mjs'

// Exercise the actual MCP implementation installed with the official SDK.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
const { Client } = sdkRequire('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = sdkRequire('@modelcontextprotocol/sdk/inMemory.js')
const { CallToolRequestSchema, ListToolsRequestSchema, McpError } = sdkRequire('@modelcontextprotocol/sdk/types.js')

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
const token = 'mkw_' + 'A'.repeat(43)
const catalogue = JSON.stringify({ version: 1, tool: {
  name: 'record_decision', title: 'Record a decision', description: 'Canonical synthetic catalogue',
  inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'], additionalProperties: false },
  annotations: { idempotentHint: true },
} })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-shared-mcp-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function fixture() {
  const root = directory(), repo = join(root, 'repo'), captures = join(root, 'captures')
  mkdirSync(repo); mkdirSync(captures)
  execFileSync('git', ['init', '--quiet', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/project.git'])
  const config = { handoffFile: join(root, 'handoff.json'), repositoryRoot: repo, capturesDir: captures, captureRoots: [repo],
    artifactRoot: repo, factoryVerify: { cwd: repo, command: process.execPath + ' --version', infer: false },
    decisionUrl: 'http://127.0.0.1:1/not-requested', decisionToken: token, decisionCatalogue: catalogue, env: { PATH: process.env.PATH } }
  const profile = { repositorySelection: true, captures: true, artifactInspection: true, factoryVerify: true, decisionCatalogue: catalogue }
  return { root, repo, captures, config, profile }
}
function authority() {
  const abort = new AbortController()
  let live = true
  return { signal: abort.signal, assertLive() { if (!live) throw new Error('Revoked') },
    revoke() { live = false }, abort: () => abort.abort() }
}
type Reply = { result?: { tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean }; error?: { code: number; message: string } }
function call(name: string, args: unknown = {}) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}
async function stdio(config: ReturnType<typeof fixture>['config']) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/agents/mikka-mcp.mjs'),
    '--handoff', config.handoffFile, '--captures', config.capturesDir, '--capture-root', config.captureRoots[0],
    '--factory-artifacts', config.artifactRoot, '--factory-verify', JSON.stringify(config.factoryVerify),
    '--repository-selection', config.repositoryRoot], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, MIKKA_DECISION_MCP_URL: config.decisionUrl, MIKKA_DECISION_MCP_TOKEN: config.decisionToken,
      MIKKA_DECISION_MCP_CATALOGUE: config.decisionCatalogue,
    } })
  child.stderr.resume()
  const ended = once(child, 'close')
  const pending = new Map<number, (reply: Reply) => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', text => { const value = JSON.parse(text); pending.get(value.id)?.(value); pending.delete(value.id) })
  let id = 0
  cleanups.push(async () => { child.stdin.end(); await ended; lines.close() })
  return { child, ended, request(method: string, params: unknown = {}) {
    const next = ++id
    return new Promise<Reply>((done, reject) => {
      const timer = setTimeout(() => { pending.delete(next); reject(new Error('stdio reply missing')) }, 5000)
      pending.set(next, reply => { clearTimeout(timer); done(reply) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
    })
  } }
}
async function sdk(backend: ReturnType<typeof prepareMikkaMcpBackend>) {
  // The installed official SDK owns its server and transport. Raw canonical
  // JSON schemas and the real handlers are retained through its public Server.
  const server = createSdkMcpServer({ name: 'mikka', version: '0.0.1' })
  server.instance.server.registerCapabilities({ tools: {} })
  server.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: backend.tools() }))
  server.instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    const response = await backend.handle({ ...request, id: 1 })
    if (response.error) throw new McpError(response.error.code, response.error.message)
    if (!response.result) throw new Error('MCP response result is required')
    return response.result
  })
  const client = new Client({ name: 'anonymous-local-fixture', version: '1' })
  const [host, consumer] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(host)
  await client.connect(consumer)
  cleanups.push(async () => { await client.close(); await server.instance.close(); await backend.close() })
  return client
}
async function httpServer(reply?: (id: number, response: ServerResponse) => void) {
  const calls: { authorization?: string; method: string; params: unknown }[] = []
  const entered = deferred(), closed = deferred()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    calls.push({ authorization: request.headers.authorization, method: body.method, params: body.params })
    response.on('close', () => closed.resolve())
    entered.resolve()
    if (reply) reply(body.id, response)
    else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'recorded' }] },
    }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) })
  return { url: 'http://127.0.0.1:' + address.port + '/mikka/api/mcp', calls, entered, closed }
}

it('keeps every canonical field identical through the real stdio and official SDK transports', async () => {
  const f = fixture(), pipe = await stdio(f.config), backend = prepareMikkaMcpBackend(f.profile), client = await sdk(backend)
  const old = await pipe.request('tools/list')
  const actual = await client.listTools()
  expect(actual.tools).toEqual(old.result!.tools)
  expect(actual.tools.map((tool: { name: string }) => tool.name)).toEqual(['submit', 'request_help', 'ask_human', 'report_blocked',
    'record_decision', 'switch_repository', 'submit_capture', 'verify_command', 'inspect_artifact', 'inspect_repository'])
  await backend.bind(f.config, authority())
  expect((await client.listTools()).tools).toEqual(actual.tools)
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('advertises only real static metadata and refuses all unbound or mid-bind tool work', async () => {
  const f = fixture(), backend = prepareMikkaMcpBackend(f.profile), client = await sdk(backend)
  await expect(client.callTool({ name: 'submit', arguments: { summary: 'unbound' } })).rejects.toThrow('Mikka tool unavailable')
  expect(existsSync(f.config.handoffFile)).toBe(false)
  const binding = backend.bind(f.config, authority())
  expect((await backend.handle(call('submit', { summary: 'binding' }))).error?.code).toBe(-32603)
  await binding
  expect(existsSync(f.config.handoffFile)).toBe(false)
  const result = await client.callTool({ name: 'submit', arguments: { summary: 'bound' } })
  expect(result.isError).not.toBe(true)
  expect(JSON.parse(readFileSync(f.config.handoffFile, 'utf8'))).toMatchObject({ kind: 'submit', summary: 'bound' })
})

it('retains the same handoff, capture bounds and repository selection handlers after one binding', async () => {
  const f = fixture(), backend = prepareMikkaMcpBackend(f.profile), client = await sdk(backend)
  await backend.bind(f.config, authority())
  await client.callTool({ name: 'ask_human', arguments: { question: 'Choose one', kind: 'decision' } })
  expect(JSON.parse(readFileSync(f.config.handoffFile, 'utf8'))).toMatchObject({ kind: 'ask', question: { question: 'Choose one', kind: 'decision' } })
  const same = await client.callTool({ name: 'switch_repository', arguments: { repository: 'example/project', reason: 'same repository' } })
  expect(JSON.stringify(same)).toContain('already_active')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
  const inside = join(f.repo, 'image.png'), outside = join(f.root, 'outside.png')
  writeFileSync(inside, png); writeFileSync(outside, png)
  expect((await client.callTool({ name: 'submit_capture', arguments: { path: outside, title: 'outside' } })).isError).toBe(true)
  expect(readdirSync(f.captures)).toEqual([])
  expect((await client.callTool({ name: 'submit_capture', arguments: { path: inside, title: 'inside' } })).isError).not.toBe(true)
  expect(readdirSync(f.captures).filter(file => file.endsWith('.png'))).toHaveLength(1)
})

it('uses the original business fetch, exact bound bearer and canonical claim catalogue without discovery or fallback storage', async () => {
  const api = await httpServer(), f = fixture(), backend = prepareMikkaMcpBackend(f.profile), client = await sdk(backend)
  await backend.bind({ ...f.config, decisionUrl: api.url }, authority())
  await client.listTools()
  expect(api.calls).toEqual([])
  expect(await client.callTool({ name: 'record_decision', arguments: { idempotencyKey: 'same-key' } }))
    .toMatchObject({ content: [{ type: 'text', text: 'recorded' }] })
  expect(api.calls).toEqual([{ authorization: 'Bearer ' + token, method: 'tools/call',
    params: { name: 'record_decision', arguments: { idempotencyKey: 'same-key' } } }])
  expect(existsSync(f.config.handoffFile)).toBe(false)
  await expect(client.callTool({ name: 'arbitrary_remote_tool', arguments: {} })).rejects.toThrow('Unknown tool')
  expect(api.calls).toHaveLength(1)
})

it.each(['missing', 'malformed', 'changed'] as const)('refuses a %s catalogue once without a remote discovery request', async mismatch => {
  const api = await httpServer(), f = fixture(), backend = prepareMikkaMcpBackend(f.profile)
  cleanups.push(() => backend.close())
  const context = { ...f.config, decisionUrl: api.url, decisionCatalogue: mismatch === 'missing' ? undefined
    : mismatch === 'malformed' ? 'not-json' : JSON.stringify({ ...JSON.parse(catalogue), tool: { ...JSON.parse(catalogue).tool, description: 'changed' } }) }
  await expect(backend.bind(context, authority())).rejects.toThrow(/catalogue/)
  await expect(backend.bind(f.config, authority())).rejects.toThrow(/bound or closed/)
  expect(api.calls).toEqual([])
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('drains a failed real path binding and never admits a replacement task', async () => {
  const f = fixture(), backend = prepareMikkaMcpBackend(f.profile)
  await expect(backend.bind({ ...f.config, repositoryRoot: join(f.root, 'absent') }, authority())).rejects.toThrow()
  await backend.close()
  await expect(backend.bind(f.config, authority())).rejects.toThrow(/bound or closed/)
  expect((await backend.handle(call('submit', { summary: 'refused' }))).error?.code).toBe(-32603)
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('never transfers a bound backend to a second run or reads later mutated context values', async () => {
  const first = fixture(), second = fixture(), backend = prepareMikkaMcpBackend(first.profile)
  cleanups.push(() => backend.close())
  const input = { ...first.config }
  await backend.bind(input, authority())
  input.handoffFile = second.config.handoffFile
  await expect(backend.bind(second.config, authority())).rejects.toThrow(/bound or closed/)
  await backend.handle(call('submit', { summary: 'first task only' }))
  expect(existsSync(first.config.handoffFile)).toBe(true)
  expect(existsSync(second.config.handoffFile)).toBe(false)
})

it.each(['predicate', 'signal'] as const)('refuses new work after local %s revocation without contacting a server', async mode => {
  const api = await httpServer(), f = fixture(), live = authority(), backend = prepareMikkaMcpBackend(f.profile)
  cleanups.push(() => backend.close())
  await backend.bind({ ...f.config, decisionUrl: api.url }, live)
  if (mode === 'predicate') live.revoke()
  else live.abort()
  expect((await backend.handle(call('record_decision', { idempotencyKey: 'refused' }))).error?.code).toBe(-32603)
  expect((await backend.handle(call('submit', { summary: 'refused' }))).error?.code).toBe(-32603)
  expect(api.calls).toEqual([]); expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('rechecks a local lease before an already queued call dispatches', async () => {
  const f = fixture(), live = authority(), backend = prepareMikkaMcpBackend(f.profile)
  cleanups.push(() => backend.close())
  await backend.bind(f.config, live)
  const pending = backend.handle(call('submit', { summary: 'revoked before dispatch' }))
  live.revoke()
  expect((await pending).error?.code).toBe(-32603)
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it.each(['unbound', 'binding'] as const)('closes and drains a %s backend without permitting later activation', async state => {
  const f = fixture(), backend = prepareMikkaMcpBackend(f.profile)
  const binding = state === 'binding' ? backend.bind(f.config, authority()) : undefined
  void binding?.catch(() => undefined)
  await backend.close()
  if (binding) await expect(binding).rejects.toThrow()
  await expect(backend.bind(f.config, authority())).rejects.toThrow(/bound or closed/)
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('aborts and drains a real held HTTP response body before closing the bound context', async () => {
  const api = await httpServer((_id, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders() })
  const f = fixture(), live = authority(), backend = prepareMikkaMcpBackend(f.profile)
  cleanups.push(() => backend.close())
  await backend.bind({ ...f.config, decisionUrl: api.url }, live)
  let settled = false
  const request = backend.handle(call('record_decision', { idempotencyKey: 'in-flight' })).then(value => { settled = true; return value })
  await api.entered.promise
  expect(settled).toBe(false)
  live.abort()
  await backend.close()
  expect(settled).toBe(true)
  expect(await request).toMatchObject({ result: { isError: true } })
  await api.closed.promise
  expect(api.calls).toHaveLength(1)
  expect(existsSync(f.config.handoffFile)).toBe(false)
})

it('keeps existing stdio EOF graceful while the original response body is still pending', async () => {
  const release = deferred()
  const api = await httpServer((id, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders()
    void release.promise.then(() => response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'completed after EOF' }] } }))) })
  const f = fixture(), pipe = await stdio({ ...f.config, decisionUrl: api.url })
  const request = pipe.request('tools/call', { name: 'record_decision', arguments: { idempotencyKey: 'held' } })
  try {
    await api.entered.promise
    pipe.child.stdin.end()
    release.resolve()
    expect(await request).toMatchObject({ result: { content: [{ type: 'text', text: 'completed after EOF' }] } })
    expect(await pipe.ended).toEqual([0, null])
  } finally { release.resolve() }
})

it('does not expose mutable catalogue references or start business work during static metadata construction', async () => {
  const profile = { decisionCatalogue: catalogue }, first = mikkaMcpToolCatalogue(profile)
  first[0].name = 'changed'
  const backend = prepareMikkaMcpBackend(profile)
  cleanups.push(() => backend.close())
  const returned = backend.tools(); returned[0].name = 'changed-again'
  expect(backend.tools()[0].name).toBe('submit')
  expect(mikkaMcpToolCatalogue(profile)[0].name).toBe('submit')
})
