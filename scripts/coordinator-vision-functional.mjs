// Offline image plan. Live Decisions run inside the application's authorized workspace scope.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DECISIONS_URL, DECISION_MODEL, decisionRequestInput } from '../lib/coordinator/decision.ts'
import { deflateSync } from 'node:zlib'

if (process.argv.slice(2).includes('--execute-synthetic-vision')) {
  throw new Error('Live Decisions require an authenticated application workspace and its billing admission. Run this command without arguments for the offline image plan.')
}
assert.equal(process.argv.length, 2, 'Unsupported acceptance arguments')

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
function image(left) {
  const width = 128, height = 64
  const header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 3 + 1))
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const red = (x < width / 2) === (left === 'red'), offset = y * (width * 3 + 1) + 1 + x * 3
    rows[offset] = red ? 255 : 0
    rows[offset + 2] = red ? 0 : 255
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const cases = ['red', 'blue'].map(expected => {
  const pixels = image(expected)
  return { expected, pixels, sha256: createHash('sha256').update(pixels).digest('hex') }
})
for (const item of cases) decisionRequestInput({ text: 'Inspect the image.', requiresVisual: true, images: [{ dataUrl: 'data:image/png;base64,' + item.pixels.toString('base64') }] })
console.log(JSON.stringify({
  model: DECISION_MODEL, endpoint: DECISIONS_URL,
  maximumGatewayRequests: 0, applicationRetries: 0,
  images: cases.map(item => ({ sha256: item.sha256, bytes: item.pixels.length, width: 128, height: 64 })),
  liveEval: false, externalActions: false,
  inferencePerformed: false,
  scope: 'offline-image-plan',
}))
