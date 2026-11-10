import { taskReviewLineComment, WorkspaceReviewError, type DiffFilePatch, type ReviewAnchor } from '@mikka/protocol/coding-workspace-review'
import { validateReviewAnchor } from '../diff/patch'

/** The UI supplies the line it saw, never a replacement hunk or current file.
 * Derive the complete anchor from that exact immutable, verified patch. */
export function taskCommentAnchor(patch: DiffFilePatch, raw: unknown): ReviewAnchor {
  const comment = taskReviewLineComment.parse(raw)
  if (patch.format !== 'text' || !patch.patch || patch.file.path !== comment.path)
    throw new WorkspaceReviewError('workspace_review_anchor_invalid')
  const side = comment.side === 'old' ? 'LEFT' : 'RIGHT'
  const hunks = patch.hunks.filter(hunk => {
    const start = side === 'LEFT' ? hunk.oldStart : hunk.newStart
    const count = side === 'LEFT' ? hunk.oldLines : hunk.newLines
    return count > 0 && comment.line >= start && comment.line < start + count
  })
  if (hunks.length !== 1) throw new WorkspaceReviewError('workspace_review_anchor_invalid')
  return validateReviewAnchor({ snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion,
    path: patch.file.path, ...(patch.file.previousPath ? { previousPath: patch.file.previousPath } : {}),
    side, lineStart: comment.line, lineEnd: comment.line, hunkFingerprint: hunks[0]!.fingerprint }, patch)
}
