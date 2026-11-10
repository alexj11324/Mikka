'use client'

// The Ask approval surface (#1735 slice A3): run-bound requests, one decision
// each. A new request invalidates this read through the existing
// `pending_actions` push; the run's own push stops it when it ends. While the
// run is live, a 3 s fallback read covers a missed push (controller ruling).
import { useState } from 'react'
import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { useLiveKey } from '@/hooks/use-live-key'
import { usePersonalApprovalScope } from '@/hooks/use-approval-live'
import { UNRESOLVED_APPROVAL_SCOPE } from '@/lib/live/approval-cache'
import { loadToolApprovals, nextToolApprovalDeadline, toolApprovalsKey, toolApprovalsLiveKeys } from '@/lib/live/tool-approval-cache'

export type ApprovalDecisionError = 'approvalAlreadyDecided' | 'approvalExpired' | 'approvalNoLongerApplies' | 'approvalUnavailable' | 'decideFailed'

export function useToolApprovals(runId: string, liveRunId: string, active: boolean) {
  const key = toolApprovalsKey(runId)
  const liveKeys = toolApprovalsLiveKeys(runId)
  const { data: session, isPending } = authClient.useSession()
  const viewer = !isPending ? session?.user.id : undefined
  // The same owner-wide scope the other approval cards use: the personal
  // workspace, never the task's team workspace.
  const workspaceId = usePersonalApprovalScope(viewer)
  const { data, error, mutate } = useSWR(key, () => loadToolApprovals(runId), {
    refreshInterval: active ? 3000 : 0,
    revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  })
  useLiveKey('pending_actions', viewer ? workspaceId ?? UNRESOLVED_APPROVAL_SCOPE : null, liveKeys, workspaceId, { deadline: nextToolApprovalDeadline(data) })
  useLiveKey('run', liveRunId, liveKeys, null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApprovalDecisionError | null>(null)

  async function decide(approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (busy) return
    setBusy(approvalId)
    setFailure(null)
    try {
      const response = await fetch(withBasePath(`/api/runs/${encodeURIComponent(runId)}/tool-approvals/${encodeURIComponent(approvalId)}`), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null
        setFailure(typeof body?.error === 'string' ? body.error as ApprovalDecisionError : 'decideFailed')
        // A refused decision means the card no longer matches the server; reread.
        void mutate()
        return
      }
      await mutate()
    } catch {
      setFailure('decideFailed')
    } finally {
      setBusy(null)
    }
  }

  return { approvals: data?.items ?? [], error, mutate, busy, failure, decide }
}
