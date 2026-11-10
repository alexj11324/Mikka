import { unstable_serialize } from 'swr'
import type { ToolApprovalMethod, ToolApprovalStatus } from '@mikka/protocol/tool-approval'
import { withBasePath } from '../base-path'
import { approvalDeadline, type ApprovalReadTime } from './approval-cache'

/** One Ask request as the approval surface reads it; the input is masked server-side. */
export interface ThreadApprovalView {
  approvalId: string
  runId: string
  status: ToolApprovalStatus
  method: ToolApprovalMethod
  tool: string
  input: Record<string, unknown>
  createdAt: string
  expiresAt: string
}
export interface ThreadApprovalPage extends ApprovalReadTime { items: ThreadApprovalView[] }

export const toolApprovalsKey = (runId: string) => ['tool-approvals', runId]
export const toolApprovalsLiveKeys = (runId: string) => [unstable_serialize(toolApprovalsKey(runId))]

export async function loadToolApprovals(runId: string): Promise<ThreadApprovalPage> {
  const requestedAt = performance.now()
  const response = await fetch(withBasePath(`/api/runs/${encodeURIComponent(runId)}/tool-approvals`), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw Error('toolApprovalsUnavailable')
  const body: unknown = await response.json().catch(() => null)
  const approvals = body && typeof body === 'object' ? (body as { approvals?: unknown }).approvals : null
  if (!Array.isArray(approvals)) throw Error('toolApprovalsUnavailable')
  return { items: approvals as ThreadApprovalView[], requestedAt, observedAt: response.headers.get('x-mikka-observed-at') ?? undefined }
}

/** At most one expiry timer per list; the server's TTL and fences stay authoritative. */
export function nextToolApprovalDeadline(page: ThreadApprovalPage | undefined) {
  return page?.items.flatMap(item => {
    if (item.status !== 'pending') return []
    const deadline = approvalDeadline(item.expiresAt, page)
    return deadline ? [deadline] : []
  }).sort((a, b) => a.afterMs - b.afterMs)[0] ?? null
}

/** The server marks an expired request when it is decided; the card shows it as expired before then. */
export function approvalExpiresAt(view: Pick<ThreadApprovalView, 'expiresAt'>) {
  return Date.parse(view.expiresAt)
}
