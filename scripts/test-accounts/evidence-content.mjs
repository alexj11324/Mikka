import { inflateRawSync } from 'node:zlib'

const MAX_ENTRIES = 2000
const MAX_TOTAL = 64 * 1024 * 1024
const MAX_ENTRY = 16 * 1024 * 1024
const MAX_DEPTH = 2
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function fail(code) { const error = new Error(code); error.code = code; throw error }
function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
export function createEvidenceScanBudget() { return { entries: 0, decodedBytes: 0, archives: 0 } }

/** Apply identically to outer artifact files and decoded report member paths. */
export function forbiddenRecordingPath(name) {
  return /\.(zip|har|webm|mp4|trace|network|stacks)$/i.test(name) || /(?:^|\/)trace(?:[./-]|$)/i.test(name)
}

/** Scan Playwright's embedded report ZIPs in memory; never extract archive paths. */
export function scanEvidenceContent(input, secretVariants, { budget = createEvidenceScanBudget() } = {}) {
  const variants = secretVariants.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)).filter(value => value.length)
  const scanSecrets = data => { for (const secret of variants) if (data.includes(secret)) fail('EVIDENCE_SECRET_DETECTED') }
  const bounds = (data, start, size, limit = data.length) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > limit) fail('EVIDENCE_ARCHIVE_MALFORMED')
  }
  const extras = data => {
    for (let at = 0; at < data.length;) {
      bounds(data, at, 4)
      const type = data.readUInt16LE(at), size = data.readUInt16LE(at + 2)
      bounds(data, at + 4, size)
      if (type === 0x0001 || type === 0x9901) fail('EVIDENCE_ARCHIVE_UNSUPPORTED')
      at += 4 + size
    }
  }
  function scanArchive(data, depth) {
    if (depth > MAX_DEPTH || data.length > MAX_TOTAL) fail('EVIDENCE_ARCHIVE_LIMIT')
    scanSecrets(data)
    let end = -1
    for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) {
      if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break }
    }
    if (end < 0) fail('EVIDENCE_ARCHIVE_MALFORMED')
    const count = data.readUInt16LE(end + 10), directorySize = data.readUInt32LE(end + 12), directoryStart = data.readUInt32LE(end + 16)
    if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) fail('EVIDENCE_ARCHIVE_UNSUPPORTED')
    if (directoryStart + directorySize !== end || budget.entries + count > MAX_ENTRIES) fail('EVIDENCE_ARCHIVE_LIMIT')
    bounds(data, directoryStart, directorySize, end)
    budget.entries += count
    budget.archives++
    const entries = [], names = new Set()
    let at = directoryStart
    for (let index = 0; index < count; index++) {
      bounds(data, at, 46, end)
      if (data.readUInt32LE(at) !== 0x02014b50) fail('EVIDENCE_ARCHIVE_MALFORMED')
      const version = data.readUInt16LE(at + 6), flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10)
      const crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24)
      const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42)
      if (version > 20 || flags & ~0x080e || ![0, 8].includes(method) || data.readUInt16LE(at + 34) || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail('EVIDENCE_ARCHIVE_UNSUPPORTED')
      if (size > MAX_ENTRY || budget.decodedBytes + size > MAX_TOTAL) fail('EVIDENCE_ARCHIVE_LIMIT')
      bounds(data, at + 46, nameLength + extraLength + commentLength, end)
      const nameBytes = data.subarray(at + 46, at + 46 + nameLength)
      const name = nameBytes.toString('utf8')
      if (!name || !Buffer.from(name).equals(nameBytes) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || names.has(name)) fail('EVIDENCE_ARCHIVE_PATH_INVALID')
      if (forbiddenRecordingPath(name)) fail('UNREVIEWED_SECRET_BEARING_EVIDENCE')
      names.add(name)
      scanSecrets(nameBytes)
      extras(data.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength))
      bounds(data, local, 30, directoryStart)
      if (data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 4) > 20 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) fail('EVIDENCE_ARCHIVE_MALFORMED')
      const localNameLength = data.readUInt16LE(local + 26), localExtraLength = data.readUInt16LE(local + 28)
      bounds(data, local + 30, localNameLength + localExtraLength, directoryStart)
      if (!data.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) fail('EVIDENCE_ARCHIVE_MALFORMED')
      extras(data.subarray(local + 30 + localNameLength, local + 30 + localNameLength + localExtraLength))
      const start = local + 30 + localNameLength + localExtraLength
      bounds(data, start, compressed, directoryStart)
      let finish = start + compressed
      if (flags & 0x0008) {
        let matched = false
        for (const prefix of [0, 4]) {
          if (prefix && (finish + 4 > directoryStart || data.readUInt32LE(finish) !== 0x08074b50)) continue
          if (finish + prefix + 12 > directoryStart) continue
          if (data.readUInt32LE(finish + prefix) === crc && data.readUInt32LE(finish + prefix + 4) === compressed && data.readUInt32LE(finish + prefix + 8) === size) { finish += prefix + 12; matched = true; break }
        }
        if (!matched) fail('EVIDENCE_ARCHIVE_MALFORMED')
      } else if (data.readUInt32LE(local + 14) !== crc || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== size) fail('EVIDENCE_ARCHIVE_MALFORMED')
      entries.push({ local, start, finish, compressed, size, method, crc })
      budget.decodedBytes += size
      at += 46 + nameLength + extraLength + commentLength
    }
    if (at !== end) fail('EVIDENCE_ARCHIVE_MALFORMED')
    let next = 0
    for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
      if (entry.local !== next) fail('EVIDENCE_ARCHIVE_MALFORMED')
      next = entry.finish
    }
    if (next !== directoryStart) fail('EVIDENCE_ARCHIVE_MALFORMED')
    for (const entry of entries) {
      let decoded
      try {
        const encoded = data.subarray(entry.start, entry.start + entry.compressed)
        if (entry.method === 0) decoded = encoded
        else {
          const result = inflateRawSync(encoded, { maxOutputLength: Math.max(1, entry.size), info: true })
          if (result.engine.bytesWritten !== encoded.length) fail('EVIDENCE_ARCHIVE_MALFORMED')
          decoded = result.buffer
        }
      } catch { fail('EVIDENCE_ARCHIVE_MALFORMED') }
      if (decoded.length !== entry.size || crc32(decoded) !== entry.crc) fail('EVIDENCE_ARCHIVE_MALFORMED')
      scanContent(decoded, depth)
    }
  }
  function scanContent(data, depth) {
    if (data.length > MAX_TOTAL) fail('EVIDENCE_ARCHIVE_LIMIT')
    scanSecrets(data)
    if (data.length >= 4 && [0x04034b50, 0x06054b50, 0x02014b50].includes(data.readUInt32LE(0))) fail('UNREVIEWED_SECRET_BEARING_EVIDENCE')
    const text = data.toString('utf8')
    const markers = /data:application\/(?:zip|x-zip-compressed)(?:;|,)/gi
    for (const match of text.matchAll(markers)) {
      const rest = text.slice(match.index)
      const prefix = /^data:application\/(?:zip|x-zip-compressed);base64,/i.exec(rest)
      if (!prefix) fail('EVIDENCE_ARCHIVE_UNSUPPORTED')
      const tail = rest.slice(prefix[0].length)
      // Bundled report JS may mention the empty literal prefix. A real payload
      // is decoded below; an empty template or malformed payload is rejected.
      if (tail.startsWith('"') || tail.startsWith("'")) continue
      const encoded = /^[A-Za-z0-9+/=\r\n\t ]+/.exec(tail)?.[0].replace(/[\r\n\t ]/g, '')
      if (!encoded || encoded.length % 4 || encoded.length > Math.ceil(MAX_TOTAL / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('EVIDENCE_ARCHIVE_MALFORMED')
      const endCharacter = tail[/^[A-Za-z0-9+/=\r\n\t ]+/.exec(tail)[0].length]
      if (endCharacter && !['<', '"', "'", ')'].includes(endCharacter)) fail('EVIDENCE_ARCHIVE_MALFORMED')
      const archive = Buffer.from(encoded, 'base64')
      if (archive.toString('base64') !== encoded) fail('EVIDENCE_ARCHIVE_MALFORMED')
      scanArchive(archive, depth + 1)
    }
  }
  scanContent(Buffer.isBuffer(input) ? input : Buffer.from(input), 0)
  return { ...budget }
}
