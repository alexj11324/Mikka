import { decode, encode } from 'cbor-x'

export const encodeRecord = value => Uint8Array.from(encode(value)).buffer
export const decodeRecord = bytes => decode(new Uint8Array(bytes))
export const first = cursor => cursor.toArray()[0]
export function fail(status, code, details = {}) { return { ok: false, status, code, ...details } }
