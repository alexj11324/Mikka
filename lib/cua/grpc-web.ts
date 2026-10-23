// Independently implemented unary gRPC-Web/protobuf subset. No upstream CUA
// implementation or generated source is bundled. See docs/computer-use.md.
import type { ComputerOperation, DesktopConfig } from './operation'

const bytes = (v: Uint8Array | string) => typeof v === 'string' ? Buffer.from(v) : Buffer.from(v)
function varint(n: number) {
  const out = []
  do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128) } while (n)
  return Buffer.from(out)
}
const uint = (field: number, n: number) => Buffer.concat([varint(field * 8), varint(n)])
const message = (field: number, value: Uint8Array | string) => Buffer.concat([varint(field * 8 + 2), varint(bytes(value).length), bytes(value)])
function double(field: number, n: number) { const value = Buffer.alloc(8); value.writeDoubleLE(n); return Buffer.concat([varint(field * 8 + 1), value]) }
const point = (x: number, y: number) => Buffer.concat([double(1, x), double(2, y)])
const keys: Record<string, number> = { SHIFT: 1, CONTROL: 4, ALT: 7, META: 10, ENTER: 20, TAB: 21, BACKSPACE: 23, DELETE: 24, ESCAPE: 25, HOME: 27, END: 28, ARROW_UP: 31, ARROW_DOWN: 32, ARROW_LEFT: 33, ARROW_RIGHT: 34 }

export function encodeOperation(operation: ComputerOperation): { method: string; payload: Buffer } {
  // Foreground delivery, coordinates in global logical screen points; never
  // silently assume screenshot pixels equal native/logical coordinates.
  const target = message(1, Buffer.concat([uint(3, 3), uint(4, 1)]))
  switch (operation.tool) {
    case 'screenshot': return { method: 'Screenshot', payload: Buffer.concat([uint(4, 1), uint(6, 1600)]) }
    case 'click': return { method: 'Pointer', payload: Buffer.concat([target, message(2, Buffer.concat([message(1, point(operation.x, operation.y)), uint(2, { left: 1, right: 2, middle: 3 }[operation.button]), uint(3, operation.count)]))]) }
    case 'scroll': return { method: 'Pointer', payload: Buffer.concat([target, message(7, Buffer.concat([message(1, point(operation.x, operation.y)), double(2, operation.deltaX), double(3, operation.deltaY), uint(4, 2)]))]) }
    case 'type': return { method: 'Keyboard', payload: Buffer.concat([target, message(2, message(1, operation.text))]) }
    case 'key': return { method: 'Keyboard', payload: Buffer.concat([target, message(4, Buffer.concat([...operation.modifiers, operation.key].map(key => message(1, uint(1, keys[key])))))]) }
  }
}
export function decodeFields(data: Buffer): Map<number, Buffer | number> {
  const fields = new Map<number, Buffer | number>()
  let cursor = 0
  function readVarint() {
    let value = 0; let shift = 0
    for (let i = 0; i < 10; i++) {
      if (cursor >= data.length) throw new Error('Truncated protobuf')
      const byte = data[cursor++]; value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
      shift += 7
    }
    throw new Error('Invalid protobuf varint')
  }
  while (cursor < data.length) {
    const tag = readVarint(); const field = Math.floor(tag / 8); const wire = tag & 7
    if (!field) throw new Error('Invalid protobuf field')
    if (wire === 0) fields.set(field, readVarint())
    else if (wire === 1 || wire === 2 || wire === 5) {
      const size = wire === 2 ? readVarint() : wire === 1 ? 8 : 4
      if (cursor + size > data.length) throw new Error('Truncated protobuf field')
      fields.set(field, data.subarray(cursor, cursor + size)); cursor += size
    } else throw new Error('Unsupported protobuf wire type')
  }
  return fields
}
export function decodeGrpcWeb(body: Buffer, headerStatus: string | null = null) {
  let cursor = 0; let payload: Buffer | undefined; let status = headerStatus
  while (cursor < body.length) {
    if (cursor + 5 > body.length) throw new Error('Truncated gRPC-Web frame')
    const flags = body[cursor]; const size = body.readUInt32BE(cursor + 1); cursor += 5
    if (cursor + size > body.length) throw new Error('Truncated gRPC-Web body')
    const frame = body.subarray(cursor, cursor + size); cursor += size
    if (flags === 128) status = /(?:^|\r?\n)grpc-status:\s*(\d+)/i.exec(frame.toString())?.[1] ?? null
    else if (flags === 0 && !payload) payload = frame
    else throw new Error('Unsupported gRPC-Web frame')
  }
  if (status !== '0') throw new Error('Desktop RPC failed')
  if (!payload) throw new Error('Desktop RPC returned no message')
  return payload
}
export async function executeDesktop(config: DesktopConfig, operation: ComputerOperation, fetcher: typeof fetch = fetch) {
  const { method, payload } = encodeOperation(operation)
  const frame = Buffer.alloc(5); frame.writeUInt32BE(payload.length, 1)
  const response = await fetcher(`${config.url}/cua.env.v1.ComputerService/${method}`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'x-cua-env-authorization': `Bearer ${config.token}` },
    body: Buffer.concat([frame, payload]),
  })
  if (!response.ok) throw new Error('Desktop connection failed')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty desktop response')
  let size = 0; const chunks: Buffer[] = []
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Desktop response too large') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  const result = decodeFields(decodeGrpcWeb(Buffer.concat(chunks), response.headers.get('grpc-status')))
  if (operation.tool !== 'screenshot') {
    // DeliveryReport is explicit evidence, not an assumed success on HTTP 200.
    const report = result.get(1)
    if (!Buffer.isBuffer(report)) throw new Error('Desktop returned no delivery report')
    const delivery = decodeFields(report)
    if (![2, 3].includes(Number(delivery.get(1)))) throw new Error('Desktop did not report delivered input')
    return { tool: operation.tool, delivery: delivery.get(1), focusChanged: delivery.get(2) === 1, pointerMoved: delivery.get(3) === 1, executed: true }
  }
  const image = result.get(1); const bounds = result.get(6); const scale = result.get(5)
  if (!Buffer.isBuffer(image) || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Desktop returned no PNG')
  return { tool: operation.tool, image: `data:image/png;base64,${image.toString('base64')}`, logicalBounds: Buffer.isBuffer(bounds) ? Object.fromEntries([...decodeFields(bounds)].map(([key, value]) => [key, Buffer.isBuffer(value) && value.length === 8 ? value.readDoubleLE() : value])) : null, scale: Buffer.isBuffer(scale) ? scale.readDoubleLE() : 1, screenshotId: result.get(7)?.toString() ?? null }
}
