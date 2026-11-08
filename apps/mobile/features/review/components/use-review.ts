import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { useHome } from '@/lib/home'
import { tasksLive } from '@/lib/live-keys'
import { useLiveApi } from '@/lib/useApi'
import { tap, warn } from '@/lib/haptics'
import { batchKey, clearBatch, useBatch } from '../model/batch-store'
import { batchIsEmpty, batchLine, type Review } from '../model/review'
import { deniedReason, merge, reviewPath, sendToAgent } from '../model/review-api'

/**
 * A task's review, its pending batch and its two actions, shared by R2 and R3. The review reads again when the task's
 * live keys arrive (tasksLive), never on a timer.
 */
export function useReview(taskId: string) {
  const home = useHome().data
  const read = useLiveApi<Review>(taskId ? reviewPath(taskId) : null, () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
  const [batch, setBatch] = useBatch(taskId)
  const [sending, setSending] = useState(false)
  const [merging, setMerging] = useState(false)
  const review = read.data
  const merged = review?.summary.pr?.state === 'merged'
  const canSend = Boolean(review?.permissions.canSend) && !merged && !batchIsEmpty(batch) && !sending

  const send = useCallback(async () => {
    if (!canSend) return
    setSending(true)
    try {
      await sendToAgent(taskId, batch, batchKey(taskId))
      tap()
      clearBatch(taskId)
      void read.reload()
    } catch {
      warn()
      Alert.alert('没能发给 Agent')
    } finally {
      setSending(false)
    }
  }, [batch, canSend, read, taskId])

  const approve = useCallback(async () => {
    if (!review?.permissions.canMerge || merging) return
    const run = async (confirmed: boolean) => {
      setMerging(true)
      try {
        const result = await merge(taskId, confirmed)
        if (result.kind === 'confirm') return Alert.alert(`还有 ${review.summary.checks.failed || 1} 项检查失败，确定合并？`, undefined, [
          { text: '取消', style: 'cancel' },
          { text: '仍然合并', style: 'destructive', onPress: () => void run(true) },
        ])
        if (result.kind === 'denied') { warn(); return Alert.alert(deniedReason(result.code)) }
        tap()
        void read.reload()
      } catch {
        warn()
        Alert.alert('没能合并')
      } finally {
        setMerging(false)
      }
    }
    // The server asks again for a failing check; the app asks first so the confirmation is one step.
    if (review.summary.checks.failed > 0) Alert.alert(`还有 ${review.summary.checks.failed} 项检查失败，确定合并？`, undefined, [
      { text: '取消', style: 'cancel' },
      { text: '仍然合并', style: 'destructive', onPress: () => void run(true) },
    ])
    else await run(false)
  }, [merging, read, review, taskId])

  return { ...read, review, batch, setBatch, line: review ? batchLine(batch, review.checks) : null, canSend, send, sending, approve, merging, merged }
}
