'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Copy, ShieldCheck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import { HarnessLabel, ModelLabel } from '@/components/labels/entity-labels'
import { currentThreadExecutionEvidence, readThreadExecutionEvidence, type ThreadExecutionEvidence } from '@/lib/thread-execution-identity-view'

export function ThreadExecutionIdentity({ runId }: { runId: string }) {
  // A different actual run closes the previous dialog and starts with no data.
  return <ExecutionIdentityDialog key={runId} runId={runId} />
}

function ExecutionIdentityDialog({ runId }: { runId: string }) {
  const t = useTranslations('IssueThreads.executionIdentity')
  const common = useTranslations('Common')
  const [open, setOpen] = useState(false)
  const { data, error, mutate } = useSWR(open ? ['thread-execution-evidence', runId] : null,
    () => readThreadExecutionEvidence(runId), { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false })
  const current = currentThreadExecutionEvidence(data, runId)
  return <Dialog open={open} onOpenChange={setOpen}>
    <Tooltip><TooltipTrigger render={<DialogTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('title')} />} />}><ShieldCheck data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('title')}</TooltipContent></Tooltip>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl" closeLabel={common('close')} aria-describedby={undefined}>
      <DialogTitle className="pr-8">{t('title')}</DialogTitle>
      <div className="min-h-0 overflow-y-auto">
        {error ? <InlineLoadError message={t('unavailable')} retryLabel={common('retry')} onRetry={() => { void mutate() }} />
          : current ? <ThreadExecutionIdentityContent key={current.id} evidence={current} />
          : <div role="status" aria-label={t('loading')} className="flex flex-col gap-3 py-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-32 w-full" /></div>}
      </div>
    </DialogContent>
  </Dialog>
}

function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
    <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 wrap-break-word">{children}</dd>
  </div>
}
function AccountReference({ id }: { id: string }) {
  return <span className="inline-flex min-w-0 items-start gap-1.5"><UserRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="break-all">{id}</span></span>
}

/** Frozen host metadata only. No current-setting fallback or credential value. */
export function ThreadExecutionIdentityContent({ evidence }: { evidence: ThreadExecutionEvidence }) {
  const t = useTranslations('IssueThreads.executionIdentity')
  const identity = evidence.executionIdentity
  async function copyRunId() {
    try { await navigator.clipboard.writeText(evidence.id); toast.success(t('copied')) }
    catch { toast.error(t('copyFailed')) }
  }
  return <div className="flex flex-col gap-5 text-sm" data-execution-evidence-run={evidence.id}>
    <dl className="flex flex-col gap-3">
      <ValueRow label={t('runId')}><span className="flex min-w-0 items-start gap-1"><span className="min-w-0 break-all tabular-nums">{evidence.id}</span><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={t('copyRunId')} onClick={() => { void copyRunId() }} />}><Copy data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('copyRunId')}</TooltipContent></Tooltip></span></ValueRow>
      <ValueRow label={t('harness')}>{evidence.harness ? <HarnessLabel harness={evidence.harness} /> : t('unknown')}</ValueRow>
      <ValueRow label={t('model')}>{evidence.model ? <span title={evidence.model}><ModelLabel model={evidence.model} /></span> : t('unknown')}</ValueRow>
      <ValueRow label={t('credential')}>{t(`credentialKinds.${evidence.credentialType}`)}</ValueRow>
      {evidence.credentialType === 'subscription' && <ValueRow label={t('subscriptionRoute')}><span className="break-all">{evidence.subscriptionRoute ?? t('unknown')}</span></ValueRow>}
    </dl>
    {!identity ? <p className="text-muted-foreground">{t('snapshotMissing')}</p> : <>
      <section className="flex flex-col gap-3"><h3 className="font-medium">{t('participants')}</h3><dl className="flex flex-col gap-3">
        <ValueRow label={t('workspace')}>{identity.workspaceId ? <span className="break-all">{identity.workspaceId}</span> : t('notRecorded')}</ValueRow>
        <ValueRow label={t('requester')}><AccountReference id={identity.requester} /></ValueRow>
        <ValueRow label={t('botOwner')}>{identity.botOwner ? <AccountReference id={identity.botOwner} /> : t('notRecorded')}</ValueRow>
        <ValueRow label={t('executionPrincipal')}><AccountReference id={identity.executionPrincipal} /></ValueRow>
        <ValueRow label={t('outputOwner')}><AccountReference id={identity.outputOwner} /></ValueRow>
      </dl></section>
      <section className="flex flex-col gap-3"><h3 className="font-medium">{t('resources')}</h3>
        {identity.resourceBindings.length === 0 ? <p className="text-muted-foreground">{t('notRecorded')}</p> : <ul className="flex flex-col gap-3">{identity.resourceBindings.map((resource, index) => <li key={`${resource.kind}:${resource.id}:${index}`} className="flex flex-col gap-1">
          <span className="font-medium">{t(`resourceKinds.${resource.kind}`)} · {t(`access.${resource.access}`)}</span>
          <dl className="flex flex-col gap-1"><ValueRow label={t('resourceOwner')}><AccountReference id={resource.ownerId} /></ValueRow><ValueRow label={t('resourceReference')}><span className="break-all">{resource.id}</span></ValueRow>
            {resource.revision && <ValueRow label={t('resourceRevision')}><span className="break-all">{resource.revision}</span></ValueRow>}
          </dl>
        </li>)}</ul>}
      </section>
      <section className="flex flex-col gap-3"><h3 className="font-medium">{t('billing')}</h3>{(['model', 'runtime'] as const).map(kind => {
        const account = identity.billingAccount[kind]
        return <dl key={kind} className="flex flex-col gap-1"><ValueRow label={t(`${kind}Billing`)}><span>{t(`accountKinds.${account.kind}`)}</span></ValueRow>
          <ValueRow label={t('payer')}><AccountReference id={account.ownerId} /></ValueRow><ValueRow label={t('resourceReference')}><span className="break-all">{account.resourceId}</span></ValueRow><ValueRow label={t('amount')}><span>{t(`amounts.${account.amount}`)}</span></ValueRow>
        </dl>
      })}</section>
    </>}
  </div>
}
