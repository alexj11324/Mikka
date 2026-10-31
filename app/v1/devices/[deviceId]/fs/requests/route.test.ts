import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let signedIn = true, owned = true
mock.module('next/server', { namedExports: { NextResponse: { json: Response.json } } })
mock.module(new URL('../../../../../../lib/device-link.ts', import.meta.url).href, { namedExports: {
  authenticateDevice: async () => signedIn ? { userId: 'PRIVATE_USER' } : null,
  ownedDevice: async () => owned ? { id: 'PRIVATE_DEVICE' } : null,
} })
mock.module(new URL('../../../../../../lib/device-route.ts', import.meta.url).href, { namedExports: {
  withDeviceRoute: (handler: unknown) => handler,
} })

let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })

test('only an authenticated owned FS poll is empty, and its logs contain no device or caller data', async () => {
  const lines: string[] = []
  const log = mock.method(console, 'log', (line: string) => { lines.push(line) })
  const warn = mock.method(console, 'warn', (line: string) => { lines.push(line) })
  const request = new Request('https://x.test/v1/devices/PRIVATE_DEVICE/fs/requests?token=SECRET', { headers: { authorization: 'Bearer SECRET' } })
  const context = { params: Promise.resolve({ deviceId: 'PRIVATE_DEVICE' }) }
  try {
    signedIn = false
    assert.equal((await GET(request, context)).status, 401)
    signedIn = true; owned = false
    assert.equal((await GET(request, context)).status, 404)
    owned = true
    assert.deepEqual(await (await GET(request, context)).json(), { requests: [] })
    const completed = lines.map(line => JSON.parse(line)).filter(entry => entry.msg === 'api_request')
    assert.deepEqual(completed.map(entry => [entry.status, entry.outcome]), [[401, undefined], [404, undefined], [200, 'empty']])
    assert.ok(completed.every(entry => entry.route === '/v1/devices/[deviceId]/fs/requests'))
    assert.ok(!lines.some(line => /PRIVATE_|SECRET/.test(line)))
  } finally { log.mock.restore(); warn.mock.restore() }
})
