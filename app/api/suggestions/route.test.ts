import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The count on 收件箱 reads `count=1` on every page: it must write and wake nothing, and count what the list shows.
const effects: string[] = []
const items = [{ id: 'a', source: 'gmail' }, { id: 'b', source: 'gmail' }, { id: 'c', source: 'github' }]
const lib = (path: string) => new URL(`../../../lib/${path}`, import.meta.url).href
mock.module(lib('api-auth.ts'), { namedExports: { getApiSession: async () => ({ user: { id: 'owner' } }) } })
mock.module(lib('background.ts'), { namedExports: { afterJob: (name: string) => { effects.push(name) } } })
mock.module(lib('db/index.ts'), { namedExports: { pool: { query: async () => ({ rows: [{ suggestionId: 'b', status: 'running', runId: null, subagentId: null }] }) } } })
mock.module(lib('suggestions/action-title.ts'), { namedExports: { ACTION_LOCALES: ['en', 'zh-CN'] } })
mock.module(lib('suggestions/action-title-server.ts'), { namedExports: { rememberLocale: async () => { effects.push('rememberLocale') } } })
mock.module(lib('suggestions/sources.ts'), { namedExports: { ensureComposioTriggers: async () => { effects.push('ensureComposioTriggers') } } })
mock.module(lib('coordinator/wake.ts'), { namedExports: { wakeCoordinator: async () => { effects.push('wakeCoordinator') } } })
mock.module(lib('suggestions/store.ts'), { namedExports: {
  listSuggestions: async () => items,
  recordTimeZone: async () => { effects.push('recordTimeZone') },
  todaysBriefing: async () => { effects.push('todaysBriefing') },
} })
mock.module(lib('suggestions/time-zone.ts'), { namedExports: { manualTimeZone: async () => null } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { effects.length = 0 })

test('count=1 counts the cards the list shows and has no side effect', async () => {
  const response = await GET(new Request('https://mikka.example/api/suggestions?count=1&tz=Asia%2FShanghai&locale=en'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { count: 2 })
  assert.deepEqual(effects, [])
})

test('the list read keeps its briefing write and its saves, and shows the same cards the count counted', async () => {
  const response = await GET(new Request('https://mikka.example/api/suggestions?tz=Asia%2FShanghai&locale=en'))
  const body = await response.json() as { groups: { items: { id: string }[] }[] }
  assert.equal(body.groups.flatMap(group => group.items).length, 2)
  assert.ok(effects.includes('todaysBriefing'))
  assert.ok(effects.includes('after:composio-triggers'))
})
