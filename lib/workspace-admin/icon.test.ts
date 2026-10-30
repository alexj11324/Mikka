import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceIcon, WORKSPACE_ICON_MAX_BYTES } from './icon'

const png = (size: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8)]).toString('base64')}`

test('accepts small raster images and clears with null or empty', () => {
  assert.equal(parseWorkspaceIcon(png(64)), png(64))
  assert.equal(parseWorkspaceIcon(png(WORKSPACE_ICON_MAX_BYTES)), png(WORKSPACE_ICON_MAX_BYTES))
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`
  assert.equal(parseWorkspaceIcon(jpeg), jpeg)
  const webp = `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]).toString('base64')}`
  assert.equal(parseWorkspaceIcon(webp), webp)
  assert.equal(parseWorkspaceIcon(null), null)
  assert.equal(parseWorkspaceIcon(''), null)
})

test('refuses oversized, SVG, mislabeled and non-data-URL values', () => {
  assert.equal(parseWorkspaceIcon(png(WORKSPACE_ICON_MAX_BYTES + 1)), false)
  assert.equal(parseWorkspaceIcon('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false)
  assert.equal(parseWorkspaceIcon(`data:image/jpeg;base64,${png(32).split(',')[1]}`), false)
  assert.equal(parseWorkspaceIcon('https://example.com/icon.png'), false)
  assert.equal(parseWorkspaceIcon('data:image/png;base64,@@@'), false)
})
