import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveErrorBody, driveErrorResponse } from './http.ts'
import { DriveError } from './store.ts'
import { DriveVolumeError } from './volumes.ts'

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

test('all Drive refusals preserve the reason-specific status and error code', async () => {
  for (const [code, status] of [
    ['drive_not_found', 404], ['drive_scope_invalid', 422], ['drive_write_invalid', 400],
    ['drive_write_invalid', 422], ['drive_version_conflict', 409], ['drive_replay_mismatch', 409],
    ['drive_limit_exceeded', 413], ['drive_limit_exceeded', 422], ['drive_blob_unknown', 422],
    ['drive_blob_size_mismatch', 422], ['drive_manifest_invalid', 422],
  ] as const) {
    const response = driveErrorResponse(new DriveError(code, status))
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: code })
  }
})

test('volume refusals retain their public code and keep the database cause private', async () => {
  const error = new DriveVolumeError('drive_volume_exists', 409, { cause: new Error('internal database detail') })
  const response = driveErrorResponse(error)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'drive_volume_exists' })
})

test('an error without a conflict detail carries no stray fields', () => {
  assert.deepEqual(driveErrorBody(new DriveError('drive_not_found', 404)), { error: 'drive_not_found' })
  // A conflict that somehow lost its detail still produces a usable body.
  assert.deepEqual(driveErrorBody(new DriveError('drive_version_conflict', 409)), { error: 'drive_version_conflict' })
})

test('a non-Drive error is rethrown rather than dressed up as a Drive failure', () => {
  assert.throws(() => driveErrorResponse(new Error('boom')), /boom/)
})
