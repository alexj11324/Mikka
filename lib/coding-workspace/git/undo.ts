import 'server-only'
import { createHash } from 'node:crypto'
import { WORKSPACE_GIT_MAX_UNDO_BYTES, WORKSPACE_GIT_MAX_UNDO_FILES } from '@mikka/protocol/coding-workspace-git'
import type { WorkspaceReadReceipt, WorkspaceReadRequest } from '@mikka/protocol/coding-workspace'
import { maskCheckpoint } from '../../secrets/checkpoint'
import type { Masker } from '../../secrets/mask'
import type { WorkspaceQuery } from '../identity'

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

async function mark(database: WorkspaceQuery, operationId: string, ownerId: string, reason: 'secret' | 'too_large' | 'none') {
  await database.query(`UPDATE coding_workspace_git_operations SET "undoFiles"=NULL,"undoMaskPolicy"=NULL,"undoAvailable"=false,
    "undoReason"=$3,"updatedAt"=now() WHERE "operationId"=$1 AND "ownerId"=$2`, [operationId, ownerId, reason])
}

/** The device reports the pre-operation bytes once. They are masked before
 * they may sit in the operation row, and content a mask would alter makes
 * Undo unavailable instead of silently restoring masked text. */
export async function retainGitUndo(database: WorkspaceQuery, request: WorkspaceReadRequest,
  receipt: WorkspaceReadReceipt, mask: Masker, ownerId: string) {
  if (request.kind !== 'git_revert_apply' && request.kind !== 'git_checkpoint_restore') return
  const undo = receipt.gitUndo
  if (!undo) return mark(database, request.operationId, ownerId, 'none')
  if (!mask.sourcePolicy) return mark(database, request.operationId, ownerId, 'none')
  const stamped: NonNullable<WorkspaceReadReceipt['gitUndo']>['files'] = []
  let changed = false, total = 0
  try {
    for (const file of undo.files) {
      const bytes = Buffer.from(file.base64, 'base64')
      if (bytes.toString('base64') !== file.base64) return mark(database, request.operationId, ownerId, 'none')
      const masked = maskCheckpoint({ patch: bytes, files: [] }, mask).patch
      if (!masked.equals(bytes)) changed = true
      total += masked.length
      stamped.push({ ...file, base64: masked.toString('base64'), sha256: digest(masked) })
    }
  } catch { return mark(database, request.operationId, ownerId, 'none') }
  if (changed) return mark(database, request.operationId, ownerId, 'secret')
  if (total > WORKSPACE_GIT_MAX_UNDO_BYTES || stamped.length > WORKSPACE_GIT_MAX_UNDO_FILES)
    return mark(database, request.operationId, ownerId, 'too_large')
  await database.query(`UPDATE coding_workspace_git_operations SET "undoFiles"=$3,"undoMaskPolicy"=$4,"undoAvailable"=true,
    "undoReason"=NULL,"updatedAt"=now() WHERE "operationId"=$1 AND "ownerId"=$2`,
  [request.operationId, ownerId, JSON.stringify(stamped), mask.sourcePolicy])
}
