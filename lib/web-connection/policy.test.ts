import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalWebServer, officialWebCallback, officialWebOriginAllowed, webConnectionEnabled, webConnectionURL } from './policy'

test('official web trust is an exact HTTPS app URL with a distinct admin kill switch', () => {
  assert.equal(webConnectionURL({}), 'https://app.aspectlylabs.com/mikka')
  assert.equal(officialWebOriginAllowed('https://app.aspectlylabs.com', {}), true)
  for (const origin of ['null', 'https://app.aspectlylabs.com.attacker.test', 'https://attacker.test', 'http://app.aspectlylabs.com']) assert.equal(officialWebOriginAllowed(origin, {}), false)
  assert.equal(webConnectionEnabled({ MIKKA_OFFICIAL_WEB_ENABLED: '0' }), false)
  assert.equal(officialWebOriginAllowed('https://app.aspectlylabs.com', { MIKKA_OFFICIAL_WEB_ENABLED: 'false' }), false)
  const env = { MIKKA_OFFICIAL_WEB_URL: 'https://official.test/app' }
  assert.equal(officialWebCallback('https://official.test/app/api/web/complete', env), 'https://official.test/app/api/web/complete')
  for (const value of ['https://official.test/other/api/web/complete', 'https://official.test/app/api/web/complete?next=evil', 'https://attacker.test/app/api/web/complete']) assert.equal(officialWebCallback(value, env), null)
})

test('server addresses reject wildcards, insecure loopback and URL-normalized traversal', () => {
  assert.equal(canonicalWebServer('https://ACME.test/mikka/'), 'https://acme.test/mikka')
  assert.equal(canonicalWebServer('https://[::1]:8443/mikka'), 'https://[::1]:8443/mikka')
  for (const value of ['http://localhost/mikka', 'http://127.0.0.1', 'https://*.acme.test', 'https://a*.test', 'https://user:pass@acme.test', 'https://acme.test/a/../mikka', 'https://acme.test/%2e%2e/mikka', 'https://acme.test/mikka?token=x', 'https://acme.test/mikka#x', 'https://acme.test\\evil', 'https://acme.test/./mikka']) assert.equal(canonicalWebServer(value), null, value)
})
