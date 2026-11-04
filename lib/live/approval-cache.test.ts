import assert from 'node:assert/strict'
import test from 'node:test'
import { unstable_serialize } from 'swr'
import { unstable_serialize as infiniteKey } from 'swr/infinite'
import { approvalDeadline, approvalExpired, approvalNow, approvedWriteListKeys, approvedWritePageKey, approvedWriteResultLiveKeys, personalApprovalWorkspace } from './approval-cache'

const home = '10000000-0000-4000-8000-000000000001', team = '10000000-0000-4000-8000-000000000002', peer = '10000000-0000-4000-8000-000000000003'

test('approval scope uses only the matching authenticated account personal workspace, never a team or another account', () => {
  const value = { accounts: [
    { id: 'other', choices: [{ id: peer, kind: 'personal' }] },
    { id: 'owner', choices: [{ id: team, kind: 'team' }, { id: home, kind: 'personal' }] },
  ] }
  assert.equal(personalApprovalWorkspace(value, 'owner'), home)
  assert.equal(personalApprovalWorkspace(value, 'other'), peer)
  assert.equal(personalApprovalWorkspace(value, 'missing'), null)
  assert.equal(personalApprovalWorkspace(undefined, 'owner'), null)
  assert.equal(personalApprovalWorkspace({ accounts: [{ id: 'owner', choices: [{ id: team, kind: 'team' }] }] }, 'owner'), null)
  assert.equal(personalApprovalWorkspace({ accounts: [{ id: 'owner', choices: [{ id: 'not-a-workspace', kind: 'personal' }] }] }, 'owner'), null)
})

test('the actual infinite-cache key includes owner and session and retains pagination boundaries', () => {
  const getKey = (_index: number, previous: { nextCursor: string | null } | null) => approvedWritePageKey('owner', 'owner:session-1', true, previous)
  const keys = approvedWriteListKeys('owner', 'owner:session-1')
  assert.deepEqual(keys, ['approved-write-availability', infiniteKey(getKey)])
  assert.notEqual(keys[1], unstable_serialize(getKey(0, null)), 'a first-page key alone cannot revalidate all loaded pages')
  assert.notEqual(keys[1], approvedWriteListKeys('owner', 'owner:session-2')[1])
  assert.notEqual(keys[1], approvedWriteListKeys('peer', 'peer:session-1')[1])
  assert.deepEqual(getKey(1, { nextCursor: 'cursor-1' }), ['approved-writes', 'owner', 'owner:session-1', 'cursor-1'])
  assert.equal(getKey(2, { nextCursor: null }), null)
  assert.equal(approvedWritePageKey('owner', 'owner:session-1', false), null)
  assert.equal(approvedWritePageKey(undefined, '', true), null)
})

test('single-result invalidation cannot alias another session, action or proposal', () => {
  const key = approvedWriteResultLiveKeys('owner:session', 'send_slack_message', home)[0]
  assert.equal(key, unstable_serialize(['approved-write-result', 'owner:session', 'send_slack_message', home]))
  assert.notEqual(key, approvedWriteResultLiveKeys('owner:other-session', 'send_slack_message', home)[0])
  assert.notEqual(key, approvedWriteResultLiveKeys('owner:session', 'cancel_calendar_event', home)[0])
  assert.notEqual(key, approvedWriteResultLiveKeys('owner:session', 'send_slack_message', team)[0])
})

test('server read time keeps an expiry fixed across renders and a slow client clock', () => {
  const observedAt = '2026-11-04T20:00:00.000Z', expiresAt = '2026-11-04T20:00:10.000Z'
  const read = { observedAt, requestedAt: 1_000 }, serverNow = Date.parse(observedAt)
  assert.deepEqual(approvalDeadline(expiresAt, read, 1_000, 0), { at: expiresAt, afterMs: 10_000 })
  assert.deepEqual(approvalDeadline(expiresAt, read, 7_000, 0), { at: expiresAt, afterMs: 4_000 })
  assert.deepEqual(approvalDeadline(expiresAt, { observedAt, requestedAt: 0 }, 6_000, 0), { at: expiresAt, afterMs: 4_000 }, 'time spent fetching is included, never added to the approval lifetime')
  assert.equal(approvalNow(read, 11_000, 0), serverNow + 10_000)
  assert.equal(approvalExpired(expiresAt, read, 11_000, 0), true)
  assert.equal(approvalDeadline(expiresAt, read, 11_000, 0), null, 'an expired read cannot start another timer')
  assert.equal(approvalExpired(expiresAt, read, 1_000, serverNow + 20_000), true, 'a fast local clock cannot extend the original UI deadline')
  assert.equal(approvalDeadline('invalid', read, 1_000, 0), null)
})
