import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeAttributes } from './sanitize'

test('workflow event transport survives export without the WebSocket endpoint or payload', () => {
  for (const transport of ['ws', 'http']) {
    const attributes = sanitizeAttributes({
      'workflow.events.transport': transport,
      'http.request.method': 'POST',
      'url.full': 'https://vercel-workflow.com/api/v4/runs/wrun_example/events/step_started',
      'workflow.events.ws.url': 'wss://private.invalid/events?token=private-token',
      'workflow.events.ws.req_id': 'private-request-id',
      'workflow.inputs': 'private-payload',
    })
    assert.equal(attributes['workflow.events.transport'], transport)
    assert.equal(attributes['http.request.method'], 'POST')
    assert.equal(attributes['workflow.events.ws.url'], undefined)
    assert.equal(attributes['workflow.events.ws.req_id'], undefined)
    assert.equal(attributes['workflow.inputs'], undefined)
    assert.ok(!JSON.stringify(attributes).includes('private-'))
  }
})

test('workflow event transport is a closed enum, not an arbitrary string export', () => {
  for (const value of ['secret-value', 'WS', 'ws?token=private', '', 1, true, ['ws'], undefined]) {
    assert.equal(sanitizeAttributes({ 'workflow.events.transport': value })['workflow.events.transport'], undefined)
  }
})
