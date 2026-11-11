import assert from 'node:assert/strict'
import test from 'node:test'
import { readAppToolCatalogue, type GitHubToolPage } from './app-tool-catalogue'
import type { AppTool } from './app-tools'

const githubPage = (pages: Record<string, GitHubToolPage>) =>
  async (userId: string, cursor?: string) => {
    assert.equal(userId, 'caller')
    return pages[cursor ?? ''] ?? { tools: [], nextCursor: null }
  }

test('GitHub pages follow the cursor, count read-only tools and keep the caller identity', async () => {
  const cursors: (string | undefined)[] = []
  const catalogue = await readAppToolCatalogue('caller', 'github', {
    githubPage: async (userId, cursor) => {
      assert.equal(userId, 'caller')
      cursors.push(cursor)
      return cursor === undefined
        ? { tools: [{ name: 'list_issues', displayName: 'List issues', readOnly: true }, { name: 'create_issue' }, null, {}], nextCursor: 'next' }
        : { tools: [{ name: 'merge_pull_request', displayName: 'Merge pull request', readOnly: false }], nextCursor: null }
    },
  })
  assert.deepEqual(cursors, [undefined, 'next'])
  assert.equal(catalogue.app, 'github')
  assert.equal(catalogue.count, 3)
  assert.equal(catalogue.readOnlyCount, 1)
  assert.equal(catalogue.truncated, false)
  assert.deepEqual(catalogue.tools[0], { name: 'list_issues', displayName: 'List issues', readOnly: true })
  // A tool without a display name falls back to its name; a missing readOnly is a write.
  assert.deepEqual(catalogue.tools[1], { name: 'create_issue', displayName: 'create_issue', readOnly: false })
})

test('GitHub stops at the tool cap and marks the catalogue truncated', async () => {
  const many = Array.from({ length: 250 }, (_, index) => ({ name: `tool_${index}`, readOnly: index % 2 === 0 }))
  const catalogue = await readAppToolCatalogue('caller', 'github', { githubPage: githubPage({ '': { tools: many, nextCursor: null } }) })
  assert.equal(catalogue.count, 200)
  assert.equal(catalogue.readOnlyCount, 100)
  assert.equal(catalogue.truncated, true)
})

test('GitHub reports truncation only when something remains past the cap', async () => {
  const exact = Array.from({ length: 200 }, (_, index) => ({ name: `tool_${index}` }))
  const withNext = await readAppToolCatalogue('caller', 'github', { githubPage: githubPage({ '': { tools: exact, nextCursor: 'more' } }) })
  assert.equal(withNext.count, 200)
  assert.equal(withNext.truncated, true, 'a next page at the cap means more remain')
  const complete = await readAppToolCatalogue('caller', 'github', { githubPage: githubPage({ '': { tools: exact, nextCursor: null } }) })
  assert.equal(complete.count, 200)
  assert.equal(complete.truncated, false, 'exactly the cap with nothing after it is complete')
})

test('GitHub stops after twelve pages and reports truncation', async () => {
  let calls = 0
  const catalogue = await readAppToolCatalogue('caller', 'github', {
    githubPage: async () => {
      calls++
      return { tools: [{ name: `tool_${calls}` }], nextCursor: `cursor_${calls}` }
    },
  })
  assert.equal(calls, 12)
  assert.equal(catalogue.count, 12)
  assert.equal(catalogue.truncated, true)
})

test('a provider error keeps what was listed and reports the error', async () => {
  const partial = await readAppToolCatalogue('caller', 'github', { githubPage: githubPage({ '': { error: 'githubNotConnected' } }) })
  assert.equal(partial.count, 0)
  assert.equal(partial.error, 'githubNotConnected')
  assert.equal(partial.truncated, true)

  const invalid = await readAppToolCatalogue('caller', 'github', { githubPage: githubPage({ '': { tools: 'not-an-array' } }) })
  assert.equal(invalid.error, 'githubToolCatalogueInvalid')
  assert.equal(invalid.truncated, true)
})

test('Composio catalogues keep only the app toolkit and map the read-only hint', async () => {
  const tools: AppTool[] = [
    { slug: 'SLACK_SEND_MESSAGE', name: 'Send message', toolkit: { slug: 'slack' }, tags: [] },
    { slug: 'SLACK_LIST_CHANNELS', name: 'List channels', toolkit: { slug: 'slack' }, tags: ['readOnlyHint'] },
    { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', toolkit: { slug: 'gmail' }, tags: [] },
    { slug: 'SLACK_OTHER', name: 'Other toolkit', toolkit: { slug: 'gmail' }, tags: [] },
  ]
  const catalogue = await readAppToolCatalogue('caller', 'slack', {
    composio: async app => {
      assert.equal(app, 'slack')
      return tools
    },
  })
  assert.equal(catalogue.app, 'slack')
  assert.equal(catalogue.count, 2)
  assert.equal(catalogue.readOnlyCount, 1)
  assert.equal(catalogue.truncated, false)
  assert.deepEqual(catalogue.tools, [
    { name: 'SLACK_SEND_MESSAGE', displayName: 'Send message', readOnly: false },
    { name: 'SLACK_LIST_CHANNELS', displayName: 'List channels', readOnly: true },
  ])
})

test('a Composio catalogue past the tool cap is truncated; exactly the cap is complete', async () => {
  const tools: AppTool[] = Array.from({ length: 201 }, (_, index) => ({ slug: `SLACK_TOOL_${index}`, name: `Tool ${index}`, toolkit: { slug: 'slack' } }))
  const catalogue = await readAppToolCatalogue('caller', 'slack', { composio: async () => tools })
  assert.equal(catalogue.count, 200)
  assert.equal(catalogue.truncated, true)
  const complete = await readAppToolCatalogue('caller', 'slack', { composio: async () => tools.slice(0, 200) })
  assert.equal(complete.count, 200)
  assert.equal(complete.truncated, false)
})

test('a large page that matches few tools is not called truncated', async () => {
  const tools: AppTool[] = [
    { slug: 'SLACK_SEND_MESSAGE', name: 'Send', toolkit: { slug: 'slack' } },
    ...Array.from({ length: 199 }, (_, index) => ({ slug: `GMAIL_TOOL_${index}`, name: `Mail ${index}`, toolkit: { slug: 'gmail' } })),
  ]
  const catalogue = await readAppToolCatalogue('caller', 'slack', { composio: async () => tools })
  assert.equal(catalogue.count, 1)
  assert.equal(catalogue.truncated, false)
})

test('Mikka’s own apps have no Composio catalogue and never call the provider', async () => {
  for (const app of ['linear', 'telegram']) {
    const catalogue = await readAppToolCatalogue('caller', app, {
      composio: async () => { throw new Error('own apps have no Composio catalogue') },
    })
    assert.deepEqual(catalogue, { app, count: 0, readOnlyCount: 0, tools: [], truncated: false }, app)
  }
})
