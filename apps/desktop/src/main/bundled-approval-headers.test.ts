import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { bundledProtocol } from './bundled-protocol'
import { RENDERER_URL } from './bundled-policy'

const owner = '84c182d1-661c-461b-bca2-10410cb646d4'
const observedAt = '2026-11-05T23:45:00.000Z'

// Exercise the actual client reader through its browser compilation boundary;
// its erased server-side model types are not main-process dependencies.
const reader = await build({
  entryPoints: [fileURLToPath(new URL('../../../../lib/live/pending-action-cache.ts', import.meta.url))],
  tsconfig: fileURLToPath(new URL('../../tsconfig.renderer.json', import.meta.url)),
  bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"' },
})
const { loadPendingActionPage } = await import(`data:text/javascript;base64,${Buffer.from(reader.outputFiles[0]!.text).toString('base64')}`) as {
  loadPendingActionPage: (ownerId: string) => Promise<{ items: unknown[]; observedAt?: string; requestedAt?: number }>
}

test('the shared approval reader accepts its verified owner and server clock through the native proxy', async t => {
  let response: Response | undefined
  const serve = bundledProtocol('/unused', { request: async path => {
    assert.equal(path, '/api/pending-actions')
    return Response.json([], { headers: {
      'x-mikka-viewer': encodeURIComponent(owner), 'x-mikka-observed-at': observedAt,
      'set-cookie': 'session_token=private', authorization: 'private',
      'x-mikka-session-token': 'private', 'x-mikka-session-cache': 'private',
    } })
  } })
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.ok(String(input).endsWith('/api/pending-actions'))
    response = await serve(new Request(`${RENDERER_URL}/api/pending-actions`))
    return response
  })
  const start = performance.now()
  const page = await loadPendingActionPage(owner)
  assert.deepEqual(page.items, [])
  assert.equal(page.observedAt, observedAt)
  assert.ok(page.requestedAt! >= start && page.requestedAt! <= performance.now())
  for (const header of ['set-cookie', 'authorization', 'x-mikka-session-token', 'x-mikka-session-cache']) {
    assert.equal(response!.headers.get(header), null, header)
  }
})

for (const viewer of [undefined, 'different-owner']) {
  test(`the native proxy does not manufacture approval ownership for ${viewer ?? 'missing'} viewer proof`, async t => {
    const serve = bundledProtocol('/unused', { request: async () => Response.json([], {
      headers: viewer ? { 'x-mikka-viewer': viewer, 'x-mikka-observed-at': observedAt } : {},
    }) })
    t.mock.method(globalThis, 'fetch', async () => serve(new Request(`${RENDERER_URL}/api/pending-actions`)))
    await assert.rejects(loadPendingActionPage(owner), /pendingActionsUnavailable/)
  })
}
