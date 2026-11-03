import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { shrinkAvatar } from './avatar-client'

const originals = new Map<string, PropertyDescriptor | undefined>()
function stubGlobal(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  originals.clear()
})

for (const [width, height, crop, output] of [
  [4000, 3000, [500, 0, 3000, 3000], 256],
  [600, 1200, [0, 300, 600, 600], 256],
  [120, 80, [20, 0, 80, 80], 80],
] as const) {
  test(`avatar ${width}×${height} resizes the full central square to ${output}px`, async () => {
    const file = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' })
    const result = new Blob(['webp'], { type: 'image/webp' })
    const bitmap = { width, height, close: mock.fn() }
    const draw = mock.fn()
    const convert = mock.fn(async () => result)
    const dimensions: number[][] = []
    stubGlobal('createImageBitmap', async () => bitmap)
    stubGlobal('OffscreenCanvas', class {
      constructor(w: number, h: number) { dimensions.push([w, h]) }
      getContext() { return { drawImage: draw } }
      convertToBlob = convert
    })
    assert.equal(await shrinkAvatar(file), result)
    assert.deepEqual(dimensions, [[output, output]])
    assert.deepEqual(draw.mock.calls[0].arguments, [bitmap, ...crop, 0, 0, output, output])
    assert.equal(bitmap.close.mock.callCount(), 1)
    assert.deepEqual(convert.mock.calls[0].arguments, [{ type: 'image/webp', quality: 0.9 }])
  })
}

test('unsupported bitmap decoding keeps the original file for server validation', async () => {
  const file = new File(['image'], 'avatar.png', { type: 'image/png' })
  stubGlobal('createImageBitmap', async () => { throw new Error('unsupported') })
  assert.equal(await shrinkAvatar(file), file)
})
