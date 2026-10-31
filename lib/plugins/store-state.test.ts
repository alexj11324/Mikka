import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesStoreQuery, storeItemState } from './store-state'

test('a connected Composio app shows …, an unconnected one +', () => {
  assert.equal(storeItemState({ kind: 'composio', accounts: 1, canLink: true, loading: false }), 'connected')
  assert.equal(storeItemState({ kind: 'composio', accounts: 2, canLink: false, loading: false }), 'connected')
  assert.equal(storeItemState({ kind: 'composio', accounts: 0, canLink: true, loading: false }), 'add')
  // No + that cannot work: connecting is not configured here.
  assert.equal(storeItemState({ kind: 'composio', accounts: 0, canLink: false, loading: false }), 'unavailable')
  // Nothing is guessed before the accounts arrive.
  assert.equal(storeItemState({ kind: 'composio', accounts: 0, canLink: true, loading: true }), null)
})

test('GitHub, Linear and Telegram follow their own state', () => {
  assert.equal(storeItemState({ kind: 'own', state: 'connected' }), 'connected')
  assert.equal(storeItemState({ kind: 'own', state: 'notConnected' }), 'add')
  assert.equal(storeItemState({ kind: 'own', state: 'paused' }), 'unavailable')
  // Not set up here: no control, and no placeholder left waiting.
  assert.equal(storeItemState({ kind: 'own', state: null }), 'unavailable')
  // Not read yet: a placeholder holds the place.
  assert.equal(storeItemState({ kind: 'own', state: undefined }), null)
})

test('search matches the name or the slug', () => {
  const hubspot = { id: 'hubspot', name: 'HubSpot' }
  assert.ok(matchesStoreQuery(hubspot, 'hub'))
  assert.ok(matchesStoreQuery(hubspot, ' SPOT '))
  assert.ok(matchesStoreQuery({ id: 'googlesheets', name: 'Google Sheets' }, 'googlesh'))
  assert.ok(matchesStoreQuery(hubspot, ''))
  assert.ok(!matchesStoreQuery(hubspot, 'slack'))
})
