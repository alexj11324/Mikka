import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUlidFactory, ulid, ulidTime } from './ulid.ts'
import { isUlidBody, isVolumeId, isVolumeVersionId, VOLUME_ID_PREFIX, VOLUME_VERSION_ID_PREFIX } from './contract.ts'

const zeros = (n: number) => new Uint8Array(n)
const ones = (n: number) => new Uint8Array(n).fill(0xff)

test('a ULID is 26 Crockford characters and accepts no excluded letter', () => {
  for (let i = 0; i < 200; i++) assert.equal(isUlidBody(ulid(1_700_000_000_000 + i)), true)
  assert.equal(ulid(0).length, 26)
  assert.equal(isUlidBody('0'.repeat(26)), true)
  assert.equal(isUlidBody('I'.repeat(26)), false)
  assert.equal(isUlidBody('L'.repeat(26)), false)
  assert.equal(isUlidBody('O'.repeat(26)), false)
  assert.equal(isUlidBody('U'.repeat(26)), false)
  assert.equal(isUlidBody('a'.repeat(26)), false, 'lower case is not a ULID')
})

test('the timestamp is the first 10 characters, and reads back exactly', () => {
  for (const time of [0, 1, 1_700_000_000_000, 2 ** 48 - 1]) {
    const id = ulid(time, zeros)
    assert.equal(ulidTime(id), time)
  }
  assert.equal(ulidTime('short'), null)
  assert.equal(ulidTime('I'.repeat(26)), null)
  assert.throws(() => ulid(-1), /driveIdTimeInvalid/)
  assert.throws(() => ulid(2 ** 48), /driveIdTimeInvalid/)
  assert.throws(() => ulid(1.5), /driveIdTimeInvalid/)
})

test('a later time sorts later as text, which is why a version list can order by id', () => {
  const early = ulid(1_700_000_000_000, ones), late = ulid(1_700_000_001_000, zeros)
  assert.ok(late > early, `${late} > ${early}`)
  // The timestamp alone decides across milliseconds, whatever the random part is.
  assert.ok(ulid(1_700_000_002_000, zeros) > ulid(1_700_000_001_999, ones))
})

test('the factory is monotonic inside one millisecond instead of racing on randomness', () => {
  const next = createUlidFactory(() => 1_700_000_000_000, zeros)
  const ids = Array.from({ length: 100 }, next)
  assert.equal(new Set(ids).size, 100, 'no id repeats')
  assert.deepEqual([...ids].sort(), ids, 'creation order is sort order')
  // All-zero randomness means any increase comes from the increment path alone:
  // the first id's random part is zeros, the second is zeros plus one.
  const time = ids[0]!.slice(0, 10)
  assert.equal(ids[0], time + '0'.repeat(16))
  assert.equal(ids[1], time + '0'.repeat(15) + '1')
  assert.equal(ids[2], time + '0'.repeat(15) + '2')
})

test('an exhausted random part moves to the next millisecond instead of repeating', () => {
  let now = 1_700_000_000_000
  const next = createUlidFactory(() => now, ones)
  const first = next()
  assert.ok(first.endsWith('Z'.repeat(16)), 'all-ones random part')
  const second = next()
  assert.ok(second > first)
  assert.equal(ulidTime(second), ulidTime(first) + 1)
})

test('volume and version ids carry their own prefix', () => {
  const nextVolume = createUlidFactory(() => 1_700_000_000_000, zeros)
  const volumeId = VOLUME_ID_PREFIX + nextVolume()
  const versionId = VOLUME_VERSION_ID_PREFIX + nextVolume()
  assert.equal(isVolumeId(volumeId), true)
  assert.equal(isVolumeVersionId(volumeId), false)
  assert.equal(isVolumeVersionId(versionId), true)
  assert.equal(isVolumeId(versionId), false)
})
