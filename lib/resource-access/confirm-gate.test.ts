import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionFailureError } from '../action-error'
import { accessChangeRefusal, withAccessConfirmation } from './confirm-gate'
import type { AudienceChange } from './audience'

// The confirmAccess ordering (ALE-26): a relation edit that changes who can read
// a resource must not write anything until the caller replays it confirmed.
// Pure: the audience reads are passed in, and the write is a counter.

const narrows = (removed: string[]): AudienceChange => ({ changed: true, narrowed: true, added: [], removed })
const widens = (added: string[]): AudienceChange => ({ changed: true, narrowed: false, added, removed: [] })
const unchanged: AudienceChange = { changed: false, narrowed: false, added: [], removed: [] }

test('an unconfirmed edit that changes the audience is refused with counts and confirmable', async () => {
  let writes = 0
  await assert.rejects(
    withAccessConfirmation(async () => [narrows(['b']), unchanged], false, async () => { writes += 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ActionFailureError)
      assert.equal(error.code, 'accessChangeConfirmationRequired')
      assert.equal(error.confirmable, true)
      assert.deepEqual(error.params, { tasks: 1, readers: 1 }, 'one task changed, one account affected')
      return true
    })
  assert.equal(writes, 0, 'the refusal happens before the write')
})

test('the same edit with confirmAccess reaches the write exactly once', async () => {
  let writes = 0
  await withAccessConfirmation(async () => [narrows(['b'])], true, async () => { writes += 1 })
  assert.equal(writes, 1)
})

test('an edit that keeps the audience needs no confirmation', async () => {
  let writes = 0
  await withAccessConfirmation(async () => [unchanged, unchanged], false, async () => { writes += 1 })
  assert.equal(writes, 1, 'nothing changes who can read it, so nothing is asked')
})

test('a widening asks too, because it publishes what was private', () => {
  const refusal = accessChangeRefusal([widens(['a', 'c'])], false)
  assert.deepEqual(refusal, { tasks: 1, readers: 2 })
})

test('several tasks report how many changed and how many distinct accounts move', () => {
  assert.deepEqual(accessChangeRefusal([narrows(['a', 'b']), narrows(['b', 'c']), unchanged], false), { tasks: 2, readers: 3 })
  assert.equal(accessChangeRefusal([unchanged], false), null)
})
