import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyCaptureFd } from '../src/agents/capture-copy.mjs'
import { createMikkaMcpBackend } from '../src/agents/mikka-mcp-backend.mjs'

test('copy keeps the checked file when its pathname is replaced by a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-fd-'))
  try {
    const file = join(dir, 'checked'), moved = join(dir, 'original'), other = join(dir, 'other'), output = join(dir, 'output')
    const allowed = Buffer.from('synthetic-allowed'), outside = Buffer.from('synthetic-outside')
    writeFileSync(file, allowed); writeFileSync(other, outside)
    const fd = openSync(file, 'r')
    try {
      renameSync(file, moved)
      symlinkSync(other, file)
      copyCaptureFd(fd, output, allowed.length)
    } finally { closeSync(fd) }
    assert.deepEqual(readFileSync(output), allowed)
    assert.notDeepEqual(readFileSync(output), outside)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('submit_capture returns the queued stable id and never declares the media ready or public', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-queue-id-'))
  const captures = join(dir, 'captures'); mkdirSync(captures)
  const image = join(dir, 'shot.png')
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const server = createMikkaMcpBackend({ handoffFile: join(dir, 'handoff.json'), capturesDir: captures, captureRoots: [dir] })
  try {
    const response = await server.handle({ id: 1, method: 'tools/call', params: { name: 'submit_capture', arguments: { path: image, title: 'Rendered test result' } } })
    const result = JSON.parse(response.result.content[0].text)
    assert.match(result.captureId, /^[0-9a-f-]{36}$/)
    assert.equal(result.status, 'queued')
    assert.equal(result.publicSafe, undefined)
    assert.deepEqual(readdirSync(captures).sort(), [`${result.captureId}.json`, `${result.captureId}.png`])
    const invalid = await server.handle({ id: 2, method: 'tools/call', params: { name: 'submit_capture', arguments: {
      path: image, title: 'Invalid timing', steps: [{ atMs: 1, durationMs: 2, label: 'Action', source: 'action' }],
    } } })
    assert.equal(invalid.result.isError, true)
    assert.equal(readdirSync(captures).length, 2)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})
