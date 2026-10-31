import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMcpSchema, updateMcpSchema } from './contracts'
import { fetchSkillSource } from './skill-source'
import { publicMcpFetch } from './public-fetch'
import { createPersonalMcpRuntime } from './mcp'
import { assertCatalogToolkit, listStoreCatalog, resetStoreCatalogCache } from './catalog'
import { executeComposioAction } from '@/lib/composio-actions'

test('MCP input rejects credential URLs, private targets, forwarded headers and credential moves', () => {
  const valid = { name: 'Docs', url: 'https://mcp.acme.dev/rpc' }
  assert.equal(createMcpSchema.safeParse(valid).success, true)
  for (const url of ['http://acme.dev', 'https://u:p@acme.dev', 'https://127.0.0.1', 'https://acme.internal', 'https://acme.dev:3000']) assert.equal(createMcpSchema.safeParse({ ...valid, url }).success, false)
  for (const name of ['Cookie', 'Host', 'Proxy-Authorization', 'x-forwarded-for']) assert.equal(createMcpSchema.safeParse({ ...valid, auth: { name, value: 'x' } }).success, false)
  assert.equal(updateMcpSchema.safeParse({ id: randomUUID(), url: 'https://another.dev' }).success, false)
})

test('transport rejects private DNS and origin changes before sending, pins DNS on the wire', async () => {
  let sent = 0
  const transport = publicMcpFetch('https://mcp.acme.dev', AbortSignal.timeout(5000), {
    resolve: async () => [{ address: '8.8.8.8' }], proxy: '',
    send: async (url, options) => {
      sent++
      assert.equal(new URL(String(url)).hostname, '8.8.8.8')
      assert.equal(new Headers(options?.headers as HeadersInit).get('host'), 'mcp.acme.dev')
      assert.equal(options?.redirect, 'error')
      return new Response('ok') as never
    },
  })
  try {
    assert.equal(await (await transport.fetch('https://mcp.acme.dev/rpc')).text(), 'ok')
    await assert.rejects(transport.fetch('https://other.acme.dev/rpc'))
    assert.equal(sent, 1)
  } finally { await transport.close() }
  const privateDns = publicMcpFetch('https://mcp.acme.dev', AbortSignal.timeout(5000), { resolve: async () => [{ address: '10.0.0.1' }], send: async () => { throw Error('must not send') } })
  try { await assert.rejects(privateDns.fetch('https://mcp.acme.dev/rpc'), /mcpPrivateAddress/) } finally { await privateDns.close() }
})

test('skill installation fetches one pinned Markdown body, rejects ambiguous and truncated trees', async () => {
  const sha = 'a'.repeat(40), calls: string[] = [], body = '---\nname: Example\n---\n# Example\nUse the existing tools.'
  let truncated = false, duplicate = false
  const source = { source: 'owner/skills', slug: 'example' }
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url)
    if (url.includes('/commits/')) return Response.json({ sha })
    if (url.includes('/git/trees/')) return Response.json({ truncated, tree: [ { path: 'skills/example/SKILL.md', type: 'blob', size: body.length }, ...(duplicate ? [{ path: 'other/example/SKILL.md', type: 'blob', size: body.length }] : []) ] })
    return new Response(body)
  }
  const skill = await fetchSkillSource(source, fetcher)
  assert.equal(skill.name, 'Example'); assert.equal(skill.body, body); assert.equal(skill.sourceRevision, sha)
  assert.match(calls.at(-1)!, new RegExp(`/owner/skills/${sha}/skills/example/SKILL.md$`))
  duplicate = true; await assert.rejects(fetchSkillSource(source, fetcher), /skillSourceAmbiguousOrMissing/)
  duplicate = false; truncated = true; await assert.rejects(fetchSkillSource(source, fetcher), /skillSourceUnavailable/)
})

test('skills.sh names resolve frontmatter rather than assuming the repository directory has that name', async () => {
  const sha = 'c'.repeat(40)
  const skill = await fetchSkillSource({ source: 'vercel-labs/agent-skills', slug: 'vercel-react-best-practices' }, async input => {
    const url = String(input)
    if (url.includes('/commits/')) return Response.json({ sha })
    if (url.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'skills/react-best-practices/SKILL.md', type: 'blob', mode: '100644', size: 100 }] })
    assert.ok(url.includes(`/${sha}/skills/react-best-practices/SKILL.md`))
    return new Response('---\nname: vercel-react-best-practices\n---\n# React guidance')
  })
  assert.equal(skill.sourcePath, 'skills/react-best-practices/SKILL.md')
  assert.equal(skill.name, 'vercel-react-best-practices')
})

for (const type of ['http', 'sse'] as const) test(`real MCP ${type} handshake, discovery, call, masking, live revocation and no retry after uncertain side effects`, async () => {
  const serverId = randomUUID(), secret = 'synthetic-fixture-only-token'
  let enabled = true, revision = 1, calls = 0, loseResponse = false, stream: import('node:http').ServerResponse | undefined
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('event: endpoint\ndata: /messages\n\n'); stream = response; return
    }
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    if (!('id' in input)) { response.writeHead(202); response.end(); return }
    const result = input.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: `echoed ${input.params.arguments.text}; ${secret}` }] }
    if (input.method === 'tools/call') { calls++; if (loseResponse) { request.socket.destroy(); return } }
    const message = JSON.stringify({ jsonrpc: '2.0', id: input.id, result })
    if (type === 'sse') { response.writeHead(202); response.end(); stream!.write(`event: message\ndata: ${message}\n\n`) }
    else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(message) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const snapshot = { servers: [{ id: serverId, name: 'Fixture', revision }], skills: [] }
  const runtime = createPersonalMcpRuntime({ mcpConnection: async (userId, id, expected) => {
    if (userId !== 'owner' || id !== serverId || !enabled || expected !== undefined && expected !== revision) throw Error('denied')
    return { id, name: 'Fixture', url: 'https://mcp.acme.dev/rpc', transport: type, enabled, revision, authKind: 'header', createdAt: '', headers: { authorization: `Bearer ${secret}` } }
  } }, { transport: (_origin, signal) => ({ fetch: (input, init) => fetch(address + new URL(String(input)).pathname, { ...init, signal }), close: async () => {} }) })
  try {
    const list = await runtime('owner', snapshot, { serverId })
    assert.equal('tools' in list && Array.isArray(list.tools) && list.tools.length, 1)
    const result = await runtime('owner', snapshot, { serverId, name: 'echo', arguments: { text: 'hello' } })
    assert.equal(calls, 1); assert.ok(JSON.stringify(result).includes('hello')); assert.ok(!JSON.stringify(result).includes(secret))
    enabled = false; assert.deepEqual(await runtime('owner', snapshot, { serverId, name: 'echo', arguments: {} }), { error: 'mcpUnavailable' }); assert.equal(calls, 1)
    enabled = true; revision++; assert.deepEqual(await runtime('owner', snapshot, { serverId }), { error: 'mcpUnavailable' })
    revision--; loseResponse = true
    assert.deepEqual(await runtime('owner', snapshot, { serverId, name: 'echo', arguments: {} }), { error: 'mcpOutcomeUnknown' }); assert.equal(calls, 2)
    assert.deepEqual(await runtime('peer', snapshot, { serverId }), { error: 'mcpUnavailable' })
    assert.deepEqual(await runtime('owner', { servers: [], skills: [] }, { serverId }), { error: 'mcpNotEnabledForExecution' })
  } finally { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('store lists every toolkit with Composio-managed auth, in Composio order, with Composio sections', async () => {
  const toolkit = (slug: string, extra: Record<string, unknown> = {}, created = '2026-01-01T00:00:00Z', categories = [{ id: 'email', name: 'email' }]) => ({ slug, name: slug.toUpperCase(), is_local_toolkit: false, no_auth: false, composio_managed_auth_schemes: ['OAUTH2'], meta: { description: 'One\nline', logo: 'https://cdn.acme.dev/icon.svg', created_at: created, categories }, ...extra })
  const pages = [
    { items: [toolkit('gmail'), toolkit('github'), toolkit('own_keys', { composio_managed_auth_schemes: [] }), toolkit('free', { no_auth: true })], next_cursor: 'p2' },
    { items: [toolkit('slack', {}, '2026-10-30T00:00:00Z', [{ id: 'chat', name: 'team chat' }, { id: 'email', name: 'email' }]), toolkit('BAD SLUG'), toolkit('gmail'), toolkit('box', { meta: { logo: 'http://insecure.acme.dev/x.svg' } })], next_cursor: null },
  ]
  const queries: unknown[] = []
  resetStoreCatalogCache()
  const catalog = await listStoreCatalog(async query => { queries.push(query); return pages[queries.length - 1] })
  assert.deepEqual(queries, [{ sort_by: 'usage', limit: 1000 }, { sort_by: 'usage', limit: 1000, cursor: 'p2' }])
  // Usage order kept; own integrations (GitHub), own-credential and no-auth toolkits, bad slugs and duplicates left out.
  assert.deepEqual(catalog.apps.map(app => app.id), ['gmail', 'slack', 'box'])
  assert.equal(catalog.apps[0].description, 'One line'); assert.equal(catalog.apps[0].name, 'GMAIL')
  assert.equal(catalog.apps[2].iconUrl, null); assert.equal(catalog.apps[2].description, '')
  assert.deepEqual(catalog.popular, ['gmail', 'slack', 'box'])
  assert.deepEqual(catalog.latest, ['slack', 'gmail'])
  assert.deepEqual(catalog.categories, [{ id: 'email', name: 'email', apps: ['gmail', 'slack'] }, { id: 'chat', name: 'team chat', apps: ['slack'] }])
  // Cached: a second read in the hour does not call Composio again.
  await listStoreCatalog(async () => { throw new Error('not cached') })
  await assert.rejects(assertCatalogToolkit(async () => pages[0], 'own_keys'), /integrationToolkitNotSupported/)
  await assertCatalogToolkit(async () => pages[0], 'slack')
  // A failed read is not kept.
  resetStoreCatalogCache()
  await assert.rejects(listStoreCatalog(async () => { throw new Error('down') }))
  assert.deepEqual((await listStoreCatalog(async () => pages[1])).apps.map(app => app.id), ['slack', 'gmail', 'box'])
  resetStoreCatalogCache()
  let execution: unknown
  const client = { connectedAccounts: { list: async () => ({ items: [{ id: 'own', toolkit: { slug: 'googledrive' }, status: 'ACTIVE', isDisabled: false, createdAt: '' }] }) }, tools: {
    getRawComposioToolBySlug: async () => ({ version: '20261022_00' }), execute: async (_slug: string, input: unknown) => { execution = input; return { successful: true, data: {} } },
  } } as unknown as Parameters<typeof executeComposioAction>[3]
  assert.ok('data' in await executeComposioAction('owner', 'list_drive_files', { query: 'trashed=false', page_size: 10, page_token: 'next' }, client))
  assert.deepEqual(execution, { userId: 'owner', connectedAccountId: 'own', version: '20261022_00', arguments: { q: 'trashed=false', pageSize: 10, pageToken: 'next' } })
  assert.deepEqual(await executeComposioAction('owner', 'GOOGLEDRIVE_DELETE_FILE', {}, client), { error: 'integrationActionNotAllowed' })
})
