import assert from 'node:assert/strict'
import test from 'node:test'
import { captureParityReaderDefaults } from './parity-reader-defaults.mjs'

const start = '2026-11-05T12:00:00.000Z'
const at = '2026-11-05T12:00:01.000Z'
const end = '2026-11-05T12:00:02.000Z'
const defaults = {
  attention_settings: { userId: 'owner', enabled: true, locale: 'en', updatedAt: at },
  user_time_zones: { userId: 'owner', timeZone: 'UTC', source: 'auto', detectedTimeZone: 'UTC', updatedAt: at },
  briefings: { userId: 'owner', localDate: '2026-11-05', kind: 'daily', timeZone: 'UTC', highlights: [], counts: {}, total: 0, createdAt: at },
}
function fixture() {
  const state = { rows: new Map(Object.keys(defaults).map(table => [table, []])), now: start, deletes: [] }
  const client = { query: async (sql, args) => {
    if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now: state.now }] }
    assert.equal(args[0], 'owner', 'every read and delete retains the exact leased owner')
    const table = /public\."([a-z_]+)"/.exec(sql)?.[1]
    assert.ok(state.rows.has(table))
    if (sql.startsWith('SELECT')) return { rows: state.rows.get(table).map(value => ({ value })) }
    assert.match(sql, /AND to_jsonb\(t\)=\$2::jsonb$/)
    state.deletes.push({ table, row: JSON.parse(args[1]) })
    return { rowCount: 1 }
  } }
  return { state, client }
}
test('pre-existing reader defaults are refused without adopting or deleting them', async () => {
  for (const [table, row] of Object.entries(defaults)) {
    const { state, client } = fixture()
    state.rows.set(table, [row])
    await assert.rejects(captureParityReaderDefaults(client, 'owner'), /PARITY_DEFAULT_BASELINE_PRESENT/)
    assert.equal(state.deletes.length, 0)
  }
})
test('only exact default rows created during this UI session are removed', async () => {
  const { state, client } = fixture()
  const cleanup = await captureParityReaderDefaults(client, 'owner')
  state.now = end
  for (const [table, row] of Object.entries(defaults)) state.rows.set(table, [row])
  await cleanup(client)
  assert.deepEqual(state.deletes, Object.entries(defaults).map(([table, row]) => ({ table, row })))
})
test('foreign, old, modified and meaningful rows fail before any deletion', async () => {
  for (const [table, patch] of [
    ['attention_settings', { userId: 'foreign' }], ['attention_settings', { enabled: false }],
    ['attention_settings', { locale: 'zh-CN' }], ['attention_settings', { updatedAt: '2026-11-05T11:59:59.999Z' }],
    ['attention_settings', { unexpected: true }], ['user_time_zones', { source: 'manual' }],
    ['user_time_zones', { timeZone: 'Asia/Shanghai' }], ['user_time_zones', { detectedTimeZone: null }],
    ['briefings', { kind: 'first' }], ['briefings', { total: 1 }], ['briefings', { highlights: ['real-suggestion'] }],
    ['briefings', { counts: { github: 1 } }], ['briefings', { localDate: '2026-11-04' }],
    ['briefings', { createdAt: '2026-11-05T12:00:03.000Z' }],
  ]) {
    const { state, client } = fixture()
    const cleanup = await captureParityReaderDefaults(client, 'owner')
    state.now = end
    for (const [name, row] of Object.entries(defaults)) state.rows.set(name, [{ ...row, ...(name === table ? patch : {}) }])
    await assert.rejects(cleanup(client), /PARITY_DEFAULT_OWNERSHIP_UNPROVEN/)
    assert.equal(state.deletes.length, 0)
  }
})
