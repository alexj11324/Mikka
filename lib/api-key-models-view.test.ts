import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApiKeyModelsView } from './api-key-models-view'

test('buildApiKeyModelsView partitions recognized vs unrecognized models and computes select-all state', () => {
  const view = buildApiKeyModelsView([
    { id: 'acme-coder-v3', enabled: false },
    { id: 'deepseek-v4', enabled: true },
    { id: 'deepseek-v4-flash', enabled: true },
    { id: 'deepseek-r2', enabled: true },
  ])

  assert.equal(view.totalCount, 4)
  assert.equal(view.enabledCount, 3)
  assert.equal(view.selectAllState, 'indeterminate')
  assert.deepEqual(
    view.items.map(item => ({ id: item.id, known: item.known, enabled: item.enabled })),
    [
      { id: 'deepseek-v4', known: true, enabled: true },
      { id: 'deepseek-v4-flash', known: true, enabled: true },
      { id: 'deepseek-r2', known: true, enabled: true },
      { id: 'acme-coder-v3', known: false, enabled: false },
    ],
  )

  // Unrecognized raw id stays raw and is placed after recognized models
  const mixed = buildApiKeyModelsView([
    { id: 'acme-internal-001', enabled: false },
    { id: 'claude-opus-5-5', enabled: true },
  ])
  assert.equal(mixed.items[0].id, 'claude-opus-5-5')
  assert.equal(mixed.items[0].known, true)
  assert.equal(mixed.items[0].displayName, 'Opus 5.5')
  assert.equal(mixed.items[1].id, 'acme-internal-001')
  assert.equal(mixed.items[1].known, false)
  assert.equal(mixed.items[1].displayName, 'acme-internal-001')
})

test('buildApiKeyModelsView honors explicit backend known flags and edge counts', () => {
  const allOn = buildApiKeyModelsView([
    { id: 'deepseek-v4', enabled: true, known: true },
    { id: 'deepseek-coder-v3', enabled: true, known: false },
  ])
  assert.equal(allOn.selectAllState, 'checked')
  assert.equal(allOn.items[1].known, false)
  assert.equal(allOn.items[1].displayName, 'deepseek-coder-v3')

  const noneOn = buildApiKeyModelsView([{ id: 'deepseek-v4', enabled: false }])
  assert.equal(noneOn.selectAllState, 'unchecked')

  const empty = buildApiKeyModelsView([])
  assert.equal(empty.selectAllState, 'unchecked')
  assert.equal(empty.totalCount, 0)
  assert.equal(empty.enabledCount, 0)
})
