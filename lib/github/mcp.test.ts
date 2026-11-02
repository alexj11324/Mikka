import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { createMCPClient } from '@ai-sdk/mcp'
import { createGitHubMcpRuntime, GITHUB_MCP_URL } from './mcp'
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
      listTools: async ({ params }: { params?: { cursor?: string } }) => ({ tools: [{ name: 'issue_read', description: `token ${OWN}`, inputSchema: {} }], nextCursor: params?.cursor ? undefined : 'next' }),
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
  const first = await runtime('owner', {}) as { tools: { name: string }[]; nextCursor: string | null }
  assert.equal(first.tools[0].name, 'issue_read'); assert.equal(first.nextCursor, 'next')
  assert.ok(!JSON.stringify(first).includes(OWN))
  assert.equal((await runtime('owner', { cursor: 'next' }) as { nextCursor: string | null }).nextCursor, null)
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

test('a refused or unreachable server logs only codes: stage, host, HTTP status, error class and network code', async () => {
  const { dependencies } = fixture()
  const logged: string[] = []
  const warn = console.warn
  console.warn = (line: unknown) => { logged.push(String(line)) }
  try {
    const refused = { ...dependencies, connect: (async () => { throw Object.assign(new Error(`MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): unauthorized for Bearer ${OWN}`), { name: 'MCPClientError' }) }) as unknown as typeof createMCPClient }
    assert.deepEqual(await createGitHubMcpRuntime(tokens([]), refused)('owner', {}), { error: 'mcpUnavailable' })
    const reset = { ...dependencies, connect: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ECONNRESET ${OWN}`), { code: 'ECONNRESET' }) }) }) as unknown as typeof createMCPClient }
    assert.deepEqual(await createGitHubMcpRuntime(tokens([]), reset)('owner', { name: 'issue_read', arguments: {} }), { error: 'mcpUnavailable' })
  } finally { console.warn = warn }
  assert.deepEqual(logged.map(line => JSON.parse(line)), [
    { event: 'mcp_unavailable', stage: 'connect', host: 'api.githubcopilot.com', status: 401, errorName: 'MCPClientError' },
    { event: 'mcp_unavailable', stage: 'connect', host: 'api.githubcopilot.com', errorName: 'TypeError', errorCode: 'ECONNRESET' },
  ])
  assert.ok(!logged.join('').includes(OWN) && !logged.join('').includes('unauthorized') && !logged.join('').includes('fetch failed'))
})

test('a known code (not connected) is not logged as unavailable', async () => {
  const { dependencies } = fixture()
  const logged: string[] = []
  const warn = console.warn
  console.warn = (line: unknown) => { logged.push(String(line)) }
  try { assert.deepEqual(await createGitHubMcpRuntime(tokens([]), dependencies)('stranger', {}), { error: 'githubNotConnected' }) } finally { console.warn = warn }
  assert.deepEqual(logged, [])
})
