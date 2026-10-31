import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAppDetail, resetAppDetailCache, type AppDetailSource } from './app-detail'

const toolkit = { slug: 'supabase', name: 'Supabase', meta: { description: 'Open-source\nbackend', logo: 'https://logos.composio.dev/api/supabase', app_url: 'https://supabase.com', version: '20261029_00', categories: [{ slug: 'databases', name: 'Databases' }, { slug: '', name: 'x' }] } }
const tool = (slug: string, tags: string[], extra: Record<string, unknown> = {}) => ({ slug, name: slug.toLowerCase(), description: `${slug} does it`, tags, toolkit: { slug: 'supabase' }, ...extra })

test('an app page comes from Composio alone, read or not connected, with tools split by readOnlyHint', async () => {
  resetAppDetailCache()
  const queries: unknown[] = []
  const source: AppDetailSource = {
    retrieve: async slug => { assert.equal(slug, 'supabase'); return toolkit },
    listTools: async query => {
      queries.push(query)
      return queries.length === 1
        ? { items: [tool('SUPABASE_LIST_TABLES', ['readOnlyHint']), tool('SUPABASE_DELETE_ROW', ['destructiveHint']), tool('SUPABASE_RUN_SQL', [])], next_cursor: 'p2' }
        : { items: [tool('SUPABASE_LIST_TABLES', ['readOnlyHint']), tool('SUPABASE_OLD', ['readOnlyHint'], { is_deprecated: true }), tool('OTHER_TOOL', ['readOnlyHint'], { toolkit: { slug: 'other' } })], next_cursor: null }
    },
  }
  const detail = await readAppDetail(source, 'supabase')
  assert.deepEqual(queries, [{ toolkit_slug: 'supabase', limit: 1000 }, { toolkit_slug: 'supabase', limit: 1000, cursor: 'p2' }])
  assert.equal(detail.description, 'Open-source backend')
  assert.deepEqual(detail.categories, [{ id: 'databases', name: 'Databases' }])
  assert.equal(detail.website, 'https://supabase.com/')
  assert.equal(detail.version, '20261029_00')
  // readOnlyHint reads; any other tool, hint or not, writes (as #658 judges writes).
  assert.deepEqual(detail.tools.read.map(item => item.slug), ['SUPABASE_LIST_TABLES'])
  assert.deepEqual(detail.tools.write.map(item => item.slug), ['SUPABASE_DELETE_ROW', 'SUPABASE_RUN_SQL'])
  // Cached: a second read in the hour does not call Composio.
  await readAppDetail({ retrieve: async () => { throw new Error('not cached') }, listTools: async () => { throw new Error('not cached') } }, 'supabase')
})

test('nothing is made up: a missing field stays missing; ours and malformed slugs are refused', async () => {
  resetAppDetailCache()
  const bare: AppDetailSource = { retrieve: async () => ({ slug: 'bare', name: 'Bare', meta: { app_url: 'http://insecure.example' } }), listTools: async () => ({ items: [] }) }
  const detail = await readAppDetail(bare, 'bare')
  assert.deepEqual({ description: detail.description, website: detail.website, version: detail.version, categories: detail.categories, tools: detail.tools }, { description: '', website: null, version: null, categories: [], tools: { write: [], read: [] } })
  for (const slug of ['github', 'Not A Slug']) await assert.rejects(readAppDetail(bare, slug), /integrationToolkitNotSupported/)
  // A failed read is not kept.
  await assert.rejects(readAppDetail({ retrieve: async () => { throw new Error('down') }, listTools: async () => ({ items: [] }) }, 'down'))
  await readAppDetail({ retrieve: async () => ({ slug: 'down', name: 'Down' }), listTools: async () => ({ items: [] }) }, 'down')
  resetAppDetailCache()
})
