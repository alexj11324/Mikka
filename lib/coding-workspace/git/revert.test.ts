import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { WorkspaceGitError } from '@mikka/protocol/coding-workspace-git'
import type { Masker } from '../../secrets/mask'
import { undoCaptureFile } from './undo'

/** The stored Undo capture is jsonb and becomes a device request. These cases
 * pin the boundary between what was stored and what may be sent. */
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const identity: Masker = Object.assign((value: string) => value, { sourcePolicy: 'd'.repeat(64) })
const redact: Masker = Object.assign((value: string) => value.replaceAll('line', 'MASK'), { sourcePolicy: 'd'.repeat(64) })
const undoUnavailable = (error: unknown) => error instanceof WorkspaceGitError && error.code === 'workspace_git_undo_unavailable'
const capture = (mode: string | null) => ({ path: 'src/a.ts', existed: true, mode,
  base64: Buffer.from('line\n').toString('base64'), sha256: digest('line\n'),
  after: { exists: true, contentSha256: 'a'.repeat(64) } })

test('a stored Undo capture becomes a four-mode request and keeps its state', () => {
  const file = undoCaptureFile(capture('100644'), identity)
  assert.equal(file.mode, '100644')
  assert.equal(file.path, 'src/a.ts')
  assert.equal(file.existed, true)
  assert.equal(file.sha256, digest('line\n'))
  assert.deepEqual(file.after, { exists: true, contentSha256: 'a'.repeat(64) })
  assert.equal(undoCaptureFile(capture('100755'), identity).mode, '100755')
  assert.equal(undoCaptureFile(capture(null), identity).mode, null)
})

test('a mode outside the Git contract is refused, never cast into the request', () => {
  // jsonb carries whatever was stored; '040000' and a symbolic mode are not
  // file modes the device may write, so the Undo is unavailable instead.
  for (const mode of ['040000', '100664', 'symlink', '']) assert.throws(() => undoCaptureFile(capture(mode), identity), undoUnavailable)
})

test('content the current mask would alter is not undoable', () => {
  // Restoring masked text would silently rewrite the file, so a policy that
  // would change these bytes disables Undo rather than shipping them.
  assert.throws(() => undoCaptureFile(capture('100644'), redact), undoUnavailable)
})
