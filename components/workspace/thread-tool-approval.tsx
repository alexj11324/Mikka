'use client'

// #1735 slice A3: the Ask approval cards above the composer. One card per
// run-bound request; approve or deny exactly what the server stored. The card
// never offers a retry for a decided or expired request: a 409 means reread.
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toolApprovalEffectiveStatus } from '@mikka/protocol/tool-approval'
import { useToolApprovals, type ApprovalDecisionError } from '@/hooks/use-tool-approvals'
import { approvalExpiresAt, type ThreadApprovalView } from '@/lib/live/tool-approval-cache'

export interface ThreadApprovalCardsContentProps {
  approvals: readonly ThreadApprovalView[]
  busy?: string | null
  failure?: ApprovalDecisionError | null
  onDecide?: (approvalId: string, decision: 'approve' | 'deny') => void
}

export function ThreadApprovalCardsContent({ approvals, busy = null, failure = null, onDecide }: ThreadApprovalCardsContentProps) {
  const t = useTranslations('IssueThreads.approval')
  if (!approvals.length && !failure) return null
  return <div data-slot="thread-approvals" className="flex flex-col gap-2 px-1">
    {approvals.map(item => {
      const status = toolApprovalEffectiveStatus(item.status, approvalExpiresAt(item))
      const waiting = status === 'approved'
      return <div key={item.approvalId} data-approval={status} className="flex flex-col gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span>{t('title')}</span><span aria-hidden="true">·</span>
          <span>{t(`method.${item.method}`)}</span><span className="truncate font-mono text-xs text-muted-foreground">{item.tool}</span>
        </p>
        <pre aria-label={t('input')} className="max-h-48 overflow-auto rounded-lg bg-background/70 px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(item.input, null, 2)}</pre>
        {status === 'pending' && <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => onDecide?.(item.approvalId, 'deny')}>{t('deny')}</Button>
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => onDecide?.(item.approvalId, 'approve')}>{busy === item.approvalId ? <Spinner aria-hidden="true" /> : null}{t('allow')}</Button>
        </div>}
        {status !== 'pending' && <p role="status" className="flex items-center gap-1.5 text-muted-foreground">
          {waiting && <Spinner aria-hidden="true" />}
          {waiting ? t('approved') : status === 'denied' ? t('denied') : status === 'expired' ? t('expired') : t('decided')}
        </p>}
      </div>
    })}
    {failure && <p role="alert" className="text-xs text-destructive-foreground">{t(failure)}</p>}
  </div>
}

/**
 * The live list for the run executing now; the panel places it above the
 * composer. It is bound to that run, never the thread's root: an answer starts
 * a continuation, and the approvals it asks for hang off the continuation.
 */
export function ThreadApprovalCards({ runId, active }: { runId: string; active: boolean }) {
  const { approvals, busy, failure, decide } = useToolApprovals(runId, active)
  return <ThreadApprovalCardsContent approvals={approvals} busy={busy} failure={failure} onDecide={(approvalId, decision) => { void decide(approvalId, decision) }} />
}
