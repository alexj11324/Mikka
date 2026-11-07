import assert from 'node:assert/strict'

const base = process.env.MIKKA_SMOKE_URL || 'http://localhost:3000/mikka'
const read = async path => {
  const response = await fetch(`${base}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, `${path} must return 200`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  return response
}
const version = await (await read('/api/version')).json()
assert.match(version.build, /^[a-f0-9]{40}$/)
if (process.env.MIKKA_EXPECTED_REVISION) assert.equal(version.build, process.env.MIKKA_EXPECTED_REVISION)
const configuration = await (await read('/api/desktop/config')).json()
assert.equal(configuration.edition, 'community')
assert.equal(configuration.googleEnabled, false)
assert.equal(configuration.githubEnabled, false)
assert.equal(configuration.emailEnabled, true)
const html = await (await read('/sign-in')).text()
assert.match(html, /<html\b/)
const asset = html.match(/(?:src|href)="(\/mikka\/assets\/[^"?#]+\.js)"/)?.[1]
assert.ok(asset, 'the image serves its compiled application')
const assetResponse = await fetch(new URL(asset, base), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
assert.equal(assetResponse.status, 200)
assert.match(assetResponse.headers.get('content-type'), /javascript/)
console.log(JSON.stringify({ status: 'passed', edition: configuration.edition, revision: version.build, origin: new URL(base).origin }))
