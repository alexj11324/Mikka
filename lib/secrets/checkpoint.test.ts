// #438 QA: the inflated-size cap on checkpoint masking (CHECKPOINT_MASK_MAX_INFLATED = 64 MiB).
import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync, gzipSync, createGzip } from 'node:zlib'
import { CHECKPOINT_MASK_MAX_INFLATED, CheckpointUnmaskable, maskCheckpoint } from './checkpoint'
import { createSecretMasker } from './mask'

const mask = createSecretMasker([{ name: 'A', value: 'sk_live_0123456789' }])
const gz = (size: number) => gzipSync(Buffer.alloc(size, 0x61), { level: 9 })

test('exactly 64 MiB inflated is masked', () => {
  assert.equal(CHECKPOINT_MASK_MAX_INFLATED, 64 * 1024 * 1024)
  const out = maskCheckpoint({ patch: gz(CHECKPOINT_MASK_MAX_INFLATED), files: [] }, mask)
  assert.equal(gunzipSync(out.patch).length, CHECKPOINT_MASK_MAX_INFLATED)
})

test('64 MiB + 1 byte is refused', () => {
  assert.throws(() => maskCheckpoint({ patch: gz(CHECKPOINT_MASK_MAX_INFLATED + 1), files: [] }, mask), CheckpointUnmaskable)
})

test('a 1 GiB-of-zeros gzip bomb is refused without inflating it', async () => {
  const gzip = createGzip({ level: 9 })
  const parts: Buffer[] = []
  gzip.on('data', (b: Buffer) => parts.push(b))
  const done = new Promise(resolve => gzip.on('end', resolve))
  const block = Buffer.alloc(16 * 1024 * 1024)
  for (let i = 0; i < 64; i++) if (!gzip.write(block)) await new Promise(r => gzip.once('drain', r))
  gzip.end(); await done
  const bomb = Buffer.concat(parts)
  assert.ok(bomb.length < 2 * 1024 * 1024)
  const before = process.memoryUsage().rss
  assert.throws(() => maskCheckpoint({ patch: bomb, files: [] }, mask), CheckpointUnmaskable)
  assert.ok(process.memoryUsage().rss - before < 512 * 1024 * 1024)
})
