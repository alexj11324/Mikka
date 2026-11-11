import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRIVE_ERROR_CODES, driveErrorBody, driveErrorResponse, driveErrorStatus, isDriveErrorCode } from './http.ts'
import { DriveError } from './store.ts'

const conflict = () => new DriveError('drive_version_conflict', 409, {
  headDigest: 'a'.repeat(64), headVersionId: 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAV', paths: ['notes/a.md', 'notes/b.md'],
})

test('a version conflict answers 409 with the tree to re-read and the paths that differ', async () => {
  const response = driveErrorResponse(conflict())
  assert.equal(response.status, 409)
  // The whole point of the conflict body: not just "409 conflict", but what to
  // re-read and which digest to retry against.
  assert.deepEqual(await response.json(), {
    error: 'drive_version_conflict',
    headDigest: 'a'.repeat(64),
    headVersionId: 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    paths: ['notes/a.md', 'notes/b.md'],
  })
})

test('each error code maps to the status a client should act on', () => {
  assert.equal(driveErrorStatus(new DriveError('drive_not_found', 404)), 404)
  assert.equal(driveErrorStatus(new DriveError('drive_write_invalid', 400)), 400)
  assert.equal(driveErrorStatus(new DriveError('drive_version_conflict', 409)), 409)
  assert.equal(driveErrorStatus(new DriveError('drive_replay_mismatch', 409)), 409)
  // A tree past the entry ceiling is a size refusal, not a validation error.
  assert.equal(driveErrorStatus(new DriveError('drive_limit_exceeded', 413)), 413)
  assert.equal(driveErrorStatus(new DriveError('drive_blob_unknown', 422)), 422)
  assert.equal(driveErrorStatus(new DriveError('drive_blob_size_mismatch', 422)), 422)
  assert.equal(driveErrorStatus(new DriveError('drive_manifest_invalid', 422)), 422)
})

test('an error without a conflict detail carries no stray fields', () => {
  assert.deepEqual(driveErrorBody(new DriveError('drive_not_found', 404)), { error: 'drive_not_found' })
  // A conflict that somehow lost its detail still produces a usable body.
  assert.deepEqual(driveErrorBody(new DriveError('drive_version_conflict', 409)), { error: 'drive_version_conflict' })
})

test('a non-Drive error is rethrown rather than dressed up as a Drive failure', () => {
  assert.throws(() => driveErrorResponse(new Error('boom')), /boom/)
})

test('every code the store can raise is known to the client-side check', () => {
  for (const code of DRIVE_ERROR_CODES) assert.equal(isDriveErrorCode(code), true, code)
  assert.equal(isDriveErrorCode('drive_something_else'), false)
  assert.equal(isDriveErrorCode(null), false)
})
