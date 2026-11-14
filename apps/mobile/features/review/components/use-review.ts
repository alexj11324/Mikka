import { useCallback, useState } from 'react'
import { confirmDestructiveAction, showSystemAlert } from '@/lib/system-alert'
import { useHome } from '@/lib/home'
import { tasksLive } from '@/lib/live-keys'
import { useLiveApi } from '@/lib/useApi'
import { tap, warn } from '@/lib/haptics'
import { batchKey, clearBatch, useBatch } from '../model/batch-store'
import { batchIsEmpty, batchLine, denial, EMPTY_BATCH, isMerged, usesVersionedReview, type ReviewCheck, type ReviewRead } from '../model/review'
import { checksPath, merge, readChecksPath, readReviewPath, reviewPath, sendToAgent, type ActionResult } from '../model/review-api'

/** A refusal (403) in the person's words, from the contract's reason code (R11). */
function refused(result: ActionResult, fallback: string) {
  if (result.kind !== 'denied') return false
  warn()
  showSystemAlert(denial(result.reason, fallback))
  return true
}

/**
 * A task's review (the contract's ReviewRead plus its checks), its pending batch and its two actions, shared by R2 and
 * R3. Both reads come again when the task's live keys arrive (tasksLive), never on a timer.
 */
export function useReview(taskId: string) {
  const home = useHome().data
  const live = () => tasksLive(home?.live?.workspaceId, home?.workspace.id)
  const read = useLiveApi<ReviewRead | null>(taskId ? reviewPath(taskId) : null, live, readReviewPath)
  const review = read.data
  const versioned = review ? usesVersionedReview(review.summary) : false
  const reference = review?.summary.reviewRef
  const checksRead = useLiveApi<ReviewCheck[]>(taskId && review && reference !== null && (!versioned || review.summary.checks) ? checksPath(taskId, reference) : null, live, readChecksPath)
  const [localBatch, updateBatch, batchScope] = useBatch(taskId)
  const batch = versioned ? EMPTY_BATCH : localBatch
  const [sending, setSending] = useState(false)
  const [merging, setMerging] = useState(false)
  const checks = checksRead.data ?? []
  const permissions = review?.summary.permissions
  const merged = review ? isMerged(review.summary) : false
  const setBatch = useCallback((next: Parameters<typeof updateBatch>[0]) => {
    if (permissions?.canSend && !versioned && !merged) updateBatch(next)
  }, [permissions?.canSend, versioned, merged, updateBatch])
  const canSend = !!batchScope && !versioned && Boolean(permissions?.canSend) && !merged && !batchIsEmpty(batch) && !sending
  const { reload } = read
  const reloadChecks = checksRead.reload
  const reloadAll = useCallback(() => Promise.all([reload(), reloadChecks()]).then(() => undefined), [reload, reloadChecks])

  const send = useCallback(async () => {
    if (!canSend || !batchScope) return
    setSending(true)
    try {
      const result = await sendToAgent(taskId, batch, batchKey(batchScope))
      if (refused(result, '没能发给 Agent')) return
      tap()
      clearBatch(batchScope)
      void reloadAll()
    } catch {
      warn()
      showSystemAlert('没能发给 Agent')
    } finally {
      setSending(false)
    }
  }, [batch, batchScope, canSend, reloadAll, taskId])

  const approve = useCallback(async () => {
    if (!review || versioned || !permissions?.canMerge || merging) return
    const failed = review.summary.checks?.failed
    const confirm = (run: () => void) => confirmDestructiveAction(
      failed ? `还有 ${failed} 项检查失败，确定合并？` : '检查未通过，确定合并？', '仍然合并', run,
    )
    const run = async (confirmed: boolean) => {
      setMerging(true)
      try {
        const result = await merge(taskId, confirmed)
        if (result.kind === 'needs_confirm') return confirm(() => void run(true))
        if (refused(result, '没能合并')) return
        tap()
        void reloadAll()
      } catch {
        warn()
        showSystemAlert('没能合并')
      } finally {
        setMerging(false)
      }
    }
    // The server asks again for a failing check (409 needs_confirm); the app asks first so it is one step.
    if (failed && failed > 0) confirm(() => void run(true))
    else await run(false)
  }, [merging, permissions, reloadAll, review, taskId, versioned])

  return {
    ...read, reload: reloadAll, review, checks, permissions, versioned, batch, setBatch,
    line: review ? batchLine(batch, checks) : null, canSend, send, sending, approve, merging, merged,
  }
}
