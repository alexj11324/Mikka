import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { createMCPClient } from '@ai-sdk/mcp'
import { createGitHubMcpRuntime } from './mcp'
import { SubscriptionService } from '../subscription-service'
import { subscriptionFixture } from '../../tests/fixtures/subscription'
import { withCoordinatorPresentation } from '../coordinator/native-prompt'

// The retained production catalogue measured 53 tools / 152,260 JSON bytes.
// These are synthetic schemas of that size, never a person's chat or credential.
function catalogue() {
  const tools = Array.from({ length: 53 }, (_, index) => ({
    name: index === 0 ? 'actions_list' : index === 1 ? 'actions_run_trigger' : `fixture_tool_${index}`,
    description: 'Synthetic external tool documentation. ',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      method: { type: 'string', enum: ['read', 'inspect'] },
    }, required: ['owner', 'repo', 'method'] },
  }))
  const remaining = 152_260 - JSON.stringify({ tools, nextCursor: null }).length
  const perTool = Math.floor(remaining / tools.length)
  for (const tool of tools) tool.description += 'x'.repeat(perTool)
  tools.at(-1)!.description += 'x'.repeat(remaining - perTool * tools.length)
  return { tools, nextCursor: null }
}

test('GitHub discovery lets the same subscription continue within its existing request limit', async () => {
  const remote = catalogue()
  const connect = (async () => ({ listTools: async () => remote, close: async () => {} })) as unknown as typeof createMCPClient
  const transport = () => ({ fetch: (async () => { throw new Error('unexpected network') }) as typeof fetch, close: async () => {} })
  const github = createGitHubMcpRuntime(async () => ({ token: 'ghu_' + 'A'.repeat(36) }), { connect, transport })

  const { use, access } = subscriptionFixture('claude_cpa')
  access.connection!.quota.observedAt = new Date().toISOString()
  const binding = { ...access.binding!, modelId: 'fixture-model' }
  const connection = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
    provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const repository = { binding: async () => binding, connection: async () => connection, scope: () => ({}) } as unknown as SubscriptionService['repository']
  const requestSizes: number[] = []
  const worker = {
    forUse() { return this },
    stream(_revision: number, model: string, payload: unknown) {
      assert.equal(model, 'fixture-model')
      requestSizes.push(JSON.stringify(payload).length)
      const chunk = { id: 'offline-fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { content: 'continued' }, finish_reason: 'stop' }] }
      return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
        controller.close()
      } })
    },
  } as unknown as ReturnType<SubscriptionService['worker']>
  const service = new SubscriptionService(repository, () => worker, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => {}, async () => {})
  const model = await service.model(use)
  if (model.specificationVersion !== 'v4') throw new Error('expected current SDK v4 model')

  // Observed host/history lengths and tool count, with synthetic text only.
  // Exercise the actual presentation rendering and provider serialization.
  const prompt: Parameters<typeof model.doStream>[0]['prompt'] = [
    { role: 'system', content: withCoordinatorPresentation('Synthetic host instructions. '.padEnd(23_881, 'x')) },
    { role: 'user', content: [{ type: 'text', text: 'Synthetic retained conversation. '.padEnd(32_819, 'x') }] },
  ]
  const tools = Array.from({ length: 79 }, (_, index) => ({ type: 'function' as const,
    name: `local_tool_${index}`, description: 'Synthetic local tool documentation. '.repeat(20),
    inputSchema: { type: 'object' as const, properties: { input: { type: 'string' as const, description: 'x'.repeat(256) } }, required: ['input'] },
  }))
  const reply = async (messages: typeof prompt) => {
    const result = await model.doStream({ prompt: messages, tools })
    let text = ''
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error
      if (part.type === 'text-delta') text += part.delta
    }
    assert.equal(text, 'continued')
  }
  await reply(prompt)
  const listed = await github('owner', {})
  console.info(JSON.stringify({ fixture: 'github_catalogue_budget', catalogueChars: JSON.stringify(listed).length, baseRequestChars: requestSizes[0] }))
  await reply([...prompt,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'catalogue', toolName: 'github_tools', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'catalogue', toolName: 'github_tools', output: { type: 'json', value: JSON.parse(JSON.stringify(listed)) } }] },
  ])
  assert.equal(requestSizes.length, 2)
})

test('an exact tool lookup returns its complete original schema without the rest of the catalogue', async () => {
  const remote = catalogue()
  const connect = (async () => ({ listTools: async () => remote, close: async () => {} })) as unknown as typeof createMCPClient
  const transport = () => ({ fetch: (async () => { throw new Error('unexpected network') }) as typeof fetch, close: async () => {} })
  const github = createGitHubMcpRuntime(async () => ({ token: 'offline-token' }), { connect, transport })
  const result = await github('owner', { tool: 'actions_run_trigger' }) as { tools: unknown[]; nextCursor: string | null }
  assert.equal(result.tools.length, 1)
  assert.deepEqual(result.tools[0], { ...remote.tools[1], displayName: 'Actions run trigger' })
  assert.equal(result.nextCursor, null)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024)
})

test('bounded discovery pages retain every tool across local and remote cursors with the caller scope intact', async () => {
  const first = Array.from({ length: 180 }, (_, index) => ({ name: `remote_${index}`, description: '説明'.repeat(240), inputSchema: { type: 'object', properties: {} } }))
  const last = { name: 'remote_last', description: 'Exact schema on the next server page', inputSchema: { type: 'object', required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } } }
  const cursors: (string | undefined)[] = []
  const owners: string[] = []
  const connect = (async () => ({
    listTools: async ({ params }: { params?: { cursor?: string } }) => {
      cursors.push(params?.cursor)
      assert.ok(params?.cursor === undefined || params.cursor === 'server-next')
      return params?.cursor ? { tools: [last], nextCursor: null } : { tools: first, nextCursor: 'server-next' }
    }, close: async () => {},
  })) as unknown as typeof createMCPClient
  const transport = () => ({ fetch: (async () => { throw new Error('unexpected network') }) as typeof fetch, close: async () => {} })
  const github = createGitHubMcpRuntime(async owner => { owners.push(owner); return { token: 'offline-token' } }, { connect, transport })
  const names: string[] = []
  let cursor: string | undefined
  let firstCursor: string | undefined
  let lastPageCursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await github('owner', cursor ? { cursor } : {}) as { tools: { name: string; inputSchema?: unknown }[]; nextCursor: string | null }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024)
    assert.ok(result.tools.every(tool => tool.inputSchema === undefined))
    names.push(...result.tools.map(tool => tool.name))
    if (result.nextCursor === null) { lastPageCursor = cursor; break }
    firstCursor ??= result.nextCursor
    cursor = result.nextCursor
  }
  assert.deepEqual(names, [...first.map(tool => tool.name), last.name])
  assert.equal(cursors.at(-1), 'server-next')
  assert.ok(cursors.slice(0, -1).every(value => value === undefined))
  assert.ok(owners.every(value => value === 'owner'))
  const exact = await github('owner', { cursor: lastPageCursor, tool: last.name }) as { tools: unknown[] }
  assert.deepEqual(exact.tools, [{ ...last, displayName: 'Remote last' }])

  const requests = owners.length
  assert.deepEqual(await github('peer', { cursor: firstCursor }), { error: 'githubToolCursorInvalid' })
  assert.deepEqual(await github('owner', { cursor: 'not-a-github-page' }), { error: 'githubToolCursorInvalid' })
  assert.equal(owners.length, requests, 'invalid/cross-owner cursors fail before token resolution or network I/O')
})

test('a schema larger than one page is explicitly refused while its summary remains discoverable', async () => {
  const remote = { tools: [{ name: 'large_tool', inputSchema: { type: 'object', properties: { value: { type: 'string', enum: Array.from({ length: 3000 }, (_, i) => `fixture-value-${i}`) } } } }], nextCursor: null }
  const connect = (async () => ({ listTools: async () => remote, close: async () => {} })) as unknown as typeof createMCPClient
  const transport = () => ({ fetch: (async () => { throw new Error('unexpected network') }) as typeof fetch, close: async () => {} })
  const github = createGitHubMcpRuntime(async () => ({ token: 'offline-token' }), { connect, transport })
  assert.deepEqual(await github('owner', {}), { tools: [{ name: 'large_tool', displayName: 'Large tool' }], nextCursor: null })
  assert.deepEqual(await github('owner', { tool: 'large_tool' }), { error: 'githubToolSchemaTooLarge' })
})

test('an opaque server cursor that cannot fit the public input contract is refused explicitly', async () => {
  const connect = (async () => ({ listTools: async () => ({ tools: [], nextCursor: '\\'.repeat(2048) }), close: async () => {} })) as unknown as typeof createMCPClient
  const transport = () => ({ fetch: (async () => { throw new Error('unexpected network') }) as typeof fetch, close: async () => {} })
  const github = createGitHubMcpRuntime(async () => ({ token: 'offline-token' }), { connect, transport })
  assert.deepEqual(await github('owner', {}), { error: 'githubToolCursorInvalid' })
})
