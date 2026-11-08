import type { DiffFileMetadata, DiffFilePatch, DiffSnapshot, TaskReviewRef } from '@mikka/protocol/coding-workspace-review'

export const reviewReference = (snapshot: DiffSnapshot): TaskReviewRef => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })

/** Missing lazy patches have unknown counts. In particular, the zeroes in a
 * working-tree manifest are not evidence of an empty change. */
export function taskReviewFile(file: DiffFileMetadata, input: { patch?: DiffFilePatch | null; reviewed?: boolean; comments: number; countsKnown?: boolean }) {
  const patch = input.patch, known = input.countsKnown ?? Boolean(patch && ['text', 'binary'].includes(patch.format))
  return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), status: file.status,
    fileVersion: file.fileVersion, additions: known ? (patch?.file.additions ?? file.additions) : null,
    deletions: known ? (patch?.file.deletions ?? file.deletions) : null, countsKnown: known,
    viewed: input.reviewed ?? false, patch: patch?.patch ?? null, format: patch?.format ?? 'unloaded',
    tooLarge: patch?.format === 'too_large', comments: input.comments }
}

export function taskReviewDiff(snapshot: DiffSnapshot, files: ReturnType<typeof taskReviewFile>[], input: {
  running: boolean; reclaimed: boolean; nextCursor: string | null;
}) {
  return { reviewRef: snapshot.availability === 'unavailable' ? null : reviewReference(snapshot), source: {
    kind: snapshot.revision.source === 'working' ? 'machine' : snapshot.revision.source === 'pull_request' ? 'pr' : snapshot.revision.source,
    at: snapshot.observedAt, reclaimed: input.reclaimed, stale: snapshot.isStale,
  }, live: snapshot.revision.source === 'working' && snapshot.availability !== 'unavailable' && input.running && !input.reclaimed && !snapshot.isStale,
  base: snapshot.revision.baseSha, head: snapshot.revision.headSha, files,
  availability: snapshot.availability, reason: snapshot.reason, empty: snapshot.availability === 'empty',
  ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}) }
}
