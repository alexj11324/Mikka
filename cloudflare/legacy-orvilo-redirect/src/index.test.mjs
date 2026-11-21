import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.mjs'

test('GET and HEAD redirect to Mikka without retaining legacy paths or queries', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/some/path?x=1', '/?next=https://example.com']) {
      const response = worker.fetch(new Request(`https://orvilo.aspectlylabs.com${path}`, { method }))
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), 'https://app.aspectlylabs.com/mikka')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await response.text(), '')
    }
  }
})

test('other methods are gone, not redirected or cached', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = worker.fetch(new Request('https://orvilo.aspectlylabs.com/some/path?x=1', { method }))
    assert.equal(response.status, 410)
    assert.equal(response.headers.get('location'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(await response.text(), 'Gone. Visit https://app.aspectlylabs.com/mikka\n')
  }
})
