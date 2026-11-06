import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deploymentPlugin, pinChunkReferences, pinnedUrl } from './deployment-plugin.mjs'

test('deployment pinning preserves relative resource paths, existing queries and hashes without pinning external URLs', () => {
  assert.equal(pinnedUrl('../chunk.js?mode=a#part', 'release-1'), '../chunk.js?mode=a&dpl=release-1#part')
  assert.equal(pinnedUrl('/mikka/a.css?dpl=old', 'new'), '/mikka/a.css?dpl=new')
  assert.equal(pinnedUrl('https://external.example/a.js', 'release-1'), 'https://external.example/a.js')
  assert.equal(pinnedUrl('//external.example/a.js', 'release-1'), '//external.example/a.js')
})

test('actual emitted static imports, lazy chunks, preload entries and CSS fonts receive the same deployment pin', () => {
  const files = new Set(['assets/main.js', 'assets/shared.js', 'assets/lazy.js', 'assets/font.woff2'])
  const code = 'import value from "./shared.js"; export const read = () => import("./lazy.js"); const preload = ["assets/shared.js"]; const other = "business-value";'
  const pinned = pinChunkReferences(code, 'assets/main.js', files, 'release-1')
  assert.match(pinned, /\.\/shared\.js\?dpl=release-1/)
  assert.match(pinned, /\.\/lazy\.js\?dpl=release-1/)
  assert.match(pinned, /assets\/shared\.js\?dpl=release-1/)
  assert.match(pinned, /"business-value"/)
  const bundle = { 'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: '' }, 'assets/main.css': { type: 'asset', fileName: 'assets/main.css', source: '@font-face{src:url(./font.woff2)}' } }
  deploymentPlugin({ deploymentId: 'release-1' }).generateBundle({}, bundle)
  assert.match(bundle['assets/main.css'].source, /font\.woff2\?dpl=release-1/)
  const html = deploymentPlugin({ deploymentId: 'release-1' }).transformIndexHtml.handler('<script type="module" src="/mikka/assets/main.js"></script><link href="/mikka/icon.svg">')
  assert.match(html, /main\.js\?dpl=release-1/)
  assert.match(html, /icon\.svg\?dpl=release-1/)
})
