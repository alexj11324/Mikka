import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { createMCPClient } from '@ai-sdk/mcp'
import { createGitHubMcpRuntime, GITHUB_MCP_URL } from './mcp'
import { runMcpCommand } from '@/lib/plugins/mcp'
import { GitHubAccessError } from './user-access-error'
import { scheduledReadTools } from '@/lib/coordinator/scheduled-read-tools'

const OWN = 'ghu_' + 'A'.repeat(36)
const OTHER = 'ghu_' + 'B'.repeat(36)

function fixture(behaviour: { echo?: boolean; failCall?: boolean } = {}) {
  const seen: { url?: string; headers?: Record<string, string>; origin?: string; calls: unknown[] } = { calls: [] }
  const connect = (async (options: Parameters<typeof createMCPClient>[0]) => {
    const transport = options.transport as { url: string; headers: Record<string, string> }
    seen.url = transport.url; seen.headers = transport.headers
    return {
      listTools: async ({ params }: { params?: { cursor?: string } }) => ({ tools: [{ name: 'issue_read', title: 'Read an issue', description: `token ${OWN}`, inputSchema: {}, annotations: { readOnlyHint: true } }], nextCursor: params?.cursor ? undefined : 'next' }),
      callTool: async (call: { name: string; arguments: unknown }) => {
        seen.calls.push(call)
        if (behaviour.failCall) throw new Error(`lost ${OWN}`)
        return { content: [{ type: 'text', text: behaviour.echo ? `Authorization: Bearer ${OWN}; base64 ${Buffer.from(OWN).toString('base64')}` : 'ok' }] }
      },
      close: async () => {},
    }
  }) as unknown as typeof createMCPClient
  const transport = (origin: string) => { seen.origin = origin; return { fetch: (async () => { throw new Error('unused') }) as typeof fetch, close: async () => {} } }
  return { seen, dependencies: { connect, transport } }
}

const tokens = (asked: string[]) => async (userId: string) => {
  asked.push(userId)
  if (userId === 'owner') return { token: OWN }
  if (userId === 'peer') return { token: OTHER }
  throw new GitHubAccessError('githubNotConnected', 409)
}

test('a call reaches the hosted GitHub MCP with only the caller\'s own token, and returns it masked', async () => {
  const asked: string[] = []
  const { seen, dependencies } = fixture({ echo: true })
  const result = await createGitHubMcpRuntime(tokens(asked), dependencies)('owner', { name: 'issue_comment', arguments: { body: 'hi' } })
  assert.deepEqual(asked, ['owner'])
  assert.equal(seen.url, GITHUB_MCP_URL); assert.equal(seen.origin, 'https://api.githubcopilot.com')
  assert.equal(seen.headers?.Authorization, `Bearer ${OWN}`)
  assert.ok(!JSON.stringify(seen.headers).includes(OTHER))
  assert.deepEqual(seen.calls.map(call => { const { name, arguments: args } = call as { name: string; arguments: unknown }; return { name, args } }), [{ name: 'issue_comment', args: { body: 'hi' } }])
  const text = JSON.stringify(result)
  assert.ok(!text.includes(OWN) && !text.includes(OWN.slice(4)) && !text.includes(Buffer.from(OWN).toString('base64')))
  assert.ok(text.includes('[redacted]'))
})

test('listing returns tools and a cursor, masked', async () => {
  const { dependencies } = fixture()
  const runtime = createGitHubMcpRuntime(tokens([]), dependencies)
  const first = await runtime('owner', {}) as { tools: { name: string; displayName: string; readOnly?: boolean }[]; nextCursor: string | null }
  assert.equal(first.tools[0].name, 'issue_read'); assert.equal(first.tools[0].displayName, 'Read an issue'); assert.equal(first.tools[0].readOnly, true); assert.equal(typeof first.nextCursor, 'string')
  assert.ok(!JSON.stringify(first).includes(OWN))
  assert.equal((await runtime('owner', { cursor: first.nextCursor! }) as { nextCursor: string | null }).nextCursor, null)
})

test('not connected is a code, and the server is never contacted', async () => {
  const { seen, dependencies } = fixture()
  assert.deepEqual(await createGitHubMcpRuntime(tokens([]), dependencies)('stranger', { name: 'issue_read', arguments: {} }), { error: 'githubNotConnected' })
  assert.equal(seen.url, undefined); assert.equal(seen.origin, undefined)
  const reconnect = createGitHubMcpRuntime(async () => { throw new GitHubAccessError('githubReconnectRequired', 401) }, dependencies)
  assert.deepEqual(await reconnect('owner', {}), { error: 'githubReconnectRequired' })
})

test('a failed call after dispatch is mcpOutcomeUnknown with no token or provider text', async () => {
  const { dependencies } = fixture({ failCall: true })
  assert.deepEqual(await createGitHubMcpRuntime(tokens([]), dependencies)('owner', { name: 'merge_pull_request', arguments: {} }), { error: 'mcpOutcomeUnknown' })
})

test('scheduled read-only turns get neither GitHub MCP tool', () => {
  const registry = { github_tools: {}, github_call: {}, web_search: {}, get_issue: {} } as never
  assert.deepEqual(Object.keys(scheduledReadTools(registry)).sort(), ['get_issue', 'web_search'])
  assert.deepEqual(Object.keys(scheduledReadTools(registry, ['github_call', 'github_tools', 'web_search'])), ['web_search'])
})

// If the hosted server refuses the GitHub App user token, only these two tools
// say mcpUnavailable; the Coordinator's other GitHub paths (find_repository,
// dispatch_run and the Agents' own credential) never go through this server.
test('a server that refuses the token is mcpUnavailable, with no call sent and no token in the result', async () => {
  const { dependencies } = fixture()
  const refusing = { ...dependencies, connect: (async () => { throw new Error(`401 Unauthorized for Bearer ${OWN}`) }) as unknown as typeof createMCPClient }
  const runtime = createGitHubMcpRuntime(tokens([]), refusing)
  const listed = await runtime('owner', {})
  const called = await runtime('owner', { name: 'issue_read', arguments: {} })
  assert.deepEqual(listed, { error: 'mcpUnavailable' })
  assert.deepEqual(called, { error: 'mcpUnavailable' })
  assert.ok(!JSON.stringify([listed, called]).includes(OWN))
})

// The real MCP SDK against a local server: the logged fields tell a refused
// token, a protocol mismatch and a network failure apart, with codes only.
test('a refused, mismatched or unreachable server logs only codes that tell them apart', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url === '/refuse') { response.writeHead(401, { 'content-type': 'text/plain' }); response.end(`unauthorized for ${request.headers.authorization}`); return }
      const { id } = JSON.parse(body || '{}') as { id?: number }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '1999-01-01', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '0' } } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const closed = createServer(); await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
  const closedPort = (closed.address() as { port: number }).port; await new Promise(resolve => closed.close(resolve))
  const plain = { transport: () => ({ fetch: globalThis.fetch, close: async () => {} }) }
  const logged: string[] = []
  const warn = console.warn
  console.warn = (line: unknown) => { logged.push(String(line)) }
  try {
    for (const url of [`http://127.0.0.1:${port}/refuse`, `http://127.0.0.1:${port}/old`, `http://127.0.0.1:${closedPort}/`]) {
      const result = await runMcpCommand(async () => ({ url, transport: 'http', headers: { Authorization: `Bearer ${OWN}` }, secrets: [OWN] }), {}, plain)
      assert.deepEqual(result, { error: 'mcpUnavailable' })
    }
  } finally { console.warn = warn; await new Promise(resolve => server.close(resolve)) }
  const [refused, mismatch, unreachable] = logged.map(line => JSON.parse(line))
  assert.equal(refused.reason, 'http'); assert.equal(refused.status, 401); assert.equal(refused.stage, 'connect'); assert.equal(refused.chain[0].name, 'MCPClientError')
  assert.equal(mismatch.reason, 'protocolVersion'); assert.equal(mismatch.protocolVersion, '1999-01-01'); assert.equal(mismatch.status, undefined)
  assert.equal(unreachable.reason, 'unknown'); assert.equal(unreachable.status, undefined)
  assert.ok(unreachable.chain.some((link: { code?: string }) => link.code === 'ECONNREFUSED'), JSON.stringify(unreachable.chain))
  const text = logged.join('\n')
  assert.ok(!text.includes(OWN) && !text.includes('unauthorized') && !text.includes('Bearer'))
})

test('a known code (not connected) is not logged as unavailable', async () => {
  const { dependencies } = fixture()
  const logged: string[] = []
  const warn = console.warn
  console.warn = (line: unknown) => { logged.push(String(line)) }
  try { assert.deepEqual(await createGitHubMcpRuntime(tokens([]), dependencies)('stranger', {}), { error: 'githubNotConnected' }) } finally { console.warn = warn }
  assert.deepEqual(logged, [])
})

test('a transport refusal (proxy on Vercel) is logged by its code', async () => {
  const { dependencies } = fixture()
  const logged: string[] = []
  const warn = console.warn
  console.warn = (line: unknown) => { logged.push(String(line)) }
  try {
    const refusing = { ...dependencies, connect: (async () => { throw new Error('mcpProxyNotAllowed') }) as unknown as typeof createMCPClient }
    assert.deepEqual(await createGitHubMcpRuntime(tokens([]), refusing)('owner', {}), { error: 'mcpUnavailable' })
  } finally { console.warn = warn }
  assert.equal(JSON.parse(logged[0]).reason, 'proxyNotAllowed')
})
