import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { createEvidenceScanBudget, forbiddenRecordingPath, scanEvidenceContent } from './evidence-content.mjs'
import { formatEvidenceFailure } from './evidence.mjs'

const canary = 'synthetic-report-credential-349'
test('actual browser configuration never records authentication traffic for upload', async () => {
  const { default: config } = await import('../../playwright.config.ts')
  assert.equal(config.use.trace, 'off')
  assert.equal(config.use.video, 'off')
  assert.equal(config.use.screenshot, 'only-on-failure')
  assert.equal(config.captureGitInfo.diff, false)
})
function crc(data) {
  let value = -1
  for (const byte of data) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ -1) >>> 0
}
// A real ZIP fixture with local entries, optional streaming descriptors,
// independent central directory and EOCD, rather than a mocked decoder.
function zip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name ?? 'report.json'), data = Buffer.from(entry.data ?? '{}')
    const method = entry.method ?? 8, flags = 0x0800 | (entry.streaming ? 8 : 0)
    const compressed = method === 0 ? data : deflateRawSync(data)
    const size = entry.declaredSize ?? data.length, checksum = crc(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8)
    if (!entry.streaming) { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22) }
    local.writeUInt16LE(name.length, 26)
    const descriptor = Buffer.alloc(entry.streaming ? 16 : 0)
    if (entry.streaming) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12) }
    const item = Buffer.concat([local, name, compressed, descriptor])
    locals.push(item)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([directory, name])); offset += item.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const html = data => Buffer.from(`<template id="playwrightReportBase64">data:application/zip;base64,${data.toString('base64')}</template>`)
const scan = (data, options) => scanEvidenceContent(data, [Buffer.from(canary)], options)

test('recording path prohibition is shared across outer artifacts and embedded report members', () => {
  for (const name of ['capture.zip', 'capture.HAR', 'video.webm', 'video.mp4', 'trace.trace', 'capture.network', 'capture.stacks', 'nested/trace', 'nested/trace-resource.json']) {
    assert.equal(forbiddenRecordingPath(name), true, name)
    assert.throws(() => scan(html(zip([{ name }]))), /UNREVIEWED_SECRET_BEARING_EVIDENCE/)
  }
  for (const name of ['report.json', 'index.html', 'screenshots/masked.png', 'playwright-browser.log']) assert.equal(forbiddenRecordingPath(name), false, name)
})

test('detects a known credential hidden inside the actual Playwright embedded ZIP format', () => {
  const report = html(zip([{ data: JSON.stringify({ error: canary }) }]))
  assert.equal(report.includes(Buffer.from(canary)), false)
  assert.equal(report.includes(Buffer.from(Buffer.from(canary).toString('base64'))), false)
  assert.throws(() => scan(report), /EVIDENCE_SECRET_DETECTED/)
})

test('accepts bounded stored and deflated reports, including streaming ZIP descriptors', () => {
  const report = html(zip([{ name: 'report.json', data: '{"passed":true}', method: 0 }, { name: 'file.json', data: '{"tests":4}', streaming: true }]))
  assert.deepEqual(scan(report), { entries: 2, decodedBytes: 26, archives: 1 })
  const prefixLiteral = Buffer.from('<script>const prefix="data:application/zip;base64,";</script>')
  assert.equal(scan(Buffer.concat([prefixLiteral, report])).entries, 2)
})

test('rejects truncated, corrupt, malformed and noncanonical archive payloads', () => {
  const original = zip([{ data: '{"passed":true}', method: 0 }])
  for (const data of [original.subarray(0, -1), Buffer.from('not a ZIP')]) assert.throws(() => scan(html(data)), /EVIDENCE_ARCHIVE_MALFORMED/)
  const corrupt = Buffer.from(original); corrupt[30 + 'report.json'.length] ^= 1
  assert.throws(() => scan(html(corrupt)), /EVIDENCE_ARCHIVE_MALFORMED/)
  assert.throws(() => scan(Buffer.from('<template>data:application/zip;base64,%%%!</template>')), /EVIDENCE_ARCHIVE_MALFORMED/)
  assert.throws(() => scan(Buffer.from('<template>data:application/zip;base64,</template>')), /EVIDENCE_ARCHIVE_MALFORMED/)
})

test('bounds declared and actual inflation size, entry count and aggregate decoded bytes', () => {
  assert.throws(() => scan(html(zip([{ data: 'small', declaredSize: 17 * 1024 * 1024 }]))), /EVIDENCE_ARCHIVE_LIMIT/)
  assert.throws(() => scan(html(zip([{ data: 'A'.repeat(1024 * 1024), declaredSize: 1 }]))), /EVIDENCE_ARCHIVE_MALFORMED/)
  const count = createEvidenceScanBudget(); count.entries = 2000
  assert.throws(() => scan(html(zip([{ data: 'small' }])), { budget: count }), /EVIDENCE_ARCHIVE_LIMIT/)
  const total = createEvidenceScanBudget(); total.decodedBytes = 64 * 1024 * 1024 - 2
  assert.throws(() => scan(html(zip([{ data: 'small' }])), { budget: total }), /EVIDENCE_ARCHIVE_LIMIT/)
})

test('rejects encryption, ZIP64, unsupported compression and ambiguous paths', () => {
  const original = zip([{ data: '{}' }])
  const central = original.readUInt32LE(original.length - 6)
  const encrypted = Buffer.from(original); encrypted.writeUInt16LE(0x0801, 6); encrypted.writeUInt16LE(0x0801, central + 8)
  const zip64 = Buffer.from(original); zip64.writeUInt32LE(0xffffffff, central + 24)
  const unsupported = Buffer.from(original); unsupported.writeUInt16LE(12, 8); unsupported.writeUInt16LE(12, central + 10)
  for (const data of [encrypted, zip64, unsupported]) assert.throws(() => scan(html(data)), /EVIDENCE_ARCHIVE_UNSUPPORTED/)
  for (const name of ['../report.json', '/report.json', 'C:/report.json']) assert.throws(() => scan(html(zip([{ name }]))), /EVIDENCE_ARCHIVE_PATH_INVALID/)
  assert.throws(() => scan(html(zip([{ name: 'same.json' }, { name: 'same.json' }]))), /EVIDENCE_ARCHIVE_PATH_INVALID/)
})

test('scans nested embedded reports but rejects excessive depth and raw nested archives', () => {
  const first = html(zip([{ data: '{}' }]))
  const second = html(zip([{ name: 'inner.html', data: first }]))
  assert.equal(scan(second).archives, 2)
  const third = html(zip([{ name: 'inner.html', data: second }]))
  assert.throws(() => scan(third), /EVIDENCE_ARCHIVE_LIMIT/)
  assert.throws(() => scan(html(zip([{ name: 'data.bin', data: zip([{ data: '{}' }]) }]))), /UNREVIEWED_SECRET_BEARING_EVIDENCE/)
})

test('rejects trace/HAR/video members and scans entry names for known secrets', () => {
  for (const name of ['trace.trace', 'capture.har', 'video.webm', 'nested/trace.zip']) assert.throws(() => scan(html(zip([{ name }]))), /UNREVIEWED_SECRET_BEARING_EVIDENCE/)
  assert.throws(() => scan(html(zip([{ name: `${canary}.json` }]))), /EVIDENCE_SECRET_DETECTED/)
})

test('public scan diagnostics expose only exact allowlisted codes, never arbitrary error fields', () => {
  const expected = safeCode => JSON.stringify({ status: 'blocked', safeCode })
  let detected
  try { scan(html(zip([{ data: canary }]))) } catch (error) { detected = error }
  assert.equal(formatEvidenceFailure(detected), expected('EVIDENCE_SECRET_DETECTED'))
  assert.equal(formatEvidenceFailure(Object.assign(new Error(canary), { code: 'UNREVIEWED_SECRET_BEARING_EVIDENCE' })), expected('UNREVIEWED_SECRET_BEARING_EVIDENCE'))

  let accessorRead = false
  const accessor = { get code() { accessorRead = true; throw new Error(canary) } }
  for (const error of [
    Object.assign(new Error(canary), { code: canary }),
    { code: `EVIDENCE_SECRET_DETECTED\n${canary}` },
    { code: { toString() { throw new Error(canary) } } },
    { message: 'EVIDENCE_SECRET_DETECTED' },
    Object.create({ code: 'EVIDENCE_SECRET_DETECTED' }),
    accessor, canary, null, undefined,
  ]) {
    const output = formatEvidenceFailure(error)
    assert.equal(output, expected('EVIDENCE_AUDIT_FAILED'))
    assert.equal(output.includes(canary), false)
  }
  assert.equal(accessorRead, false)
})

test('the actual evidence CLI exits one with a safe code for missing evidence and unknown filesystem errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), `mikka-evidence-${canary}-`))
  const script = fileURLToPath(new URL('./evidence.mjs', import.meta.url))
  const childEnvironment = { ...process.env }
  delete childEnvironment.NODE_TEST_CONTEXT
  const check = async safeCode => {
    const child = spawn(process.execPath, [script], { cwd: directory, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const [status, signal] = await once(child, 'close')
    assert.equal(signal, null)
    assert.equal(status, 1)
    assert.equal(stdout, '')
    assert.equal(stderr.trim(), JSON.stringify({ status: 'blocked', safeCode }))
    assert.equal(stderr.includes(canary), false)
  }
  try {
    await check('EVIDENCE_MISSING')
    await symlink('playwright-report', join(directory, 'playwright-report'))
    await check('EVIDENCE_AUDIT_FAILED')
  } finally { if (process.env.MIKKA_RETAIN_TEST_FILES === '1') console.log('Retained private test-account fixture'); else await rm(directory, { recursive: true, force: true }) }
})
