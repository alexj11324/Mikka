'use client'

import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowRight, ChevronRight, CircleCheck, CircleX, ExternalLink, Play } from 'lucide-react'
import { getArtifact } from '@/app/actions/artifacts'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import { resultRows, type AcceptanceDetail, type ResultRow } from '@/lib/factory/acceptance-view'
import type { FactoryFlow } from '@/lib/factory/flow-client'
import { pullNumberOf } from '@/lib/factory/artifact-review'
import type { ArtifactMedia } from '@/lib/artifacts/types'
import { cn } from '@/lib/utils'
import { useArtifactReview } from './artifact-review'
import type { FactoryTask } from './factory-acceptance-pane'
import { CountBadges, isFlowV2 } from './factory-flow'
import { PullRequestIcon } from './pull-request-icon'
import { ShortSha } from './short-sha'
import { Counts, FileSection, useDiffWrap } from './thread-changes'
import { useReviewSummary } from '@/hooks/code-review/use-review-summary'

const capturePath = (media: ArtifactMedia) => withBasePath(`/api/captures/${media.captureId}`)
/** The first files of 改动 in the report; 查看改动 opens all of them. */
const REPORT_FILES = 4

function Row({ label, children, end }: { label: string; children: ReactNode; end?: ReactNode }) {
  return <div className="flex min-h-7 min-w-0 items-center gap-3">
    <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
    <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    {end}
  </div>
}

/**
 * A PR's acceptance report (P1, decision 2026-11-06-1615), above the report's
 * own criteria and review findings: the PR and its verdicts, one card with the
 * branch, the checks and the commit, the change with the agent's summary and
 * its files, and the evidence. Read-only; the actions sit in the window header.
 */
export function AcceptanceReport({ artifactId, issueId, runId, detail, flow, results, banner }: {
  artifactId: string
  issueId: string
  /** The candidate's run: its saved work tree is the change set. */
  runId: string | null
  detail: AcceptanceDetail
  flow: FactoryFlow | null
  /** The independent review and verify on the current candidate. */
  results: ResultRow[]
  /** A state that needs saying first: the fix run, a refused merge, failed checks. */
  banner?: ReactNode
}) {
  const t = useTranslations('ArtifactReview')
  const delivery = detail.delivery
  const pr = delivery?.pullRequest ?? null
  const number = pullNumberOf(pr?.url)
  const sha = delivery?.candidateSha ?? null
  const { data: artifact } = useSWR(['artifact', artifactId], () => getArtifact(artifactId))
  const { data: changes } = useThreadChanges(issueId, runId ?? null)
  const [allChanges, setAllChanges] = useState(false)
  const [open, setOpen] = useState<readonly string[] | null>(null)
  const [viewing, setViewing] = useState<ArtifactMedia | null>(null)
  const [wrap] = useDiffWrap()
  const ready = changes?.state === 'ready' ? changes.changes : null
  const files = ready ? allChanges ? ready.files : ready.files.slice(0, REPORT_FILES) : []
  // One file open by default (the first); all of them in 查看改动.
  const opened = open ?? (allChanges ? files.map(file => file.path) : files.slice(0, 1).map(file => file.path))
  // One count model with the review page (task-08): Checks are the CI checks on the PR head, Evidence the criteria with
  // evidence out of all of them; 未验证 is said apart. Without the CI summary the row keeps the review and verify results.
  const { data: review } = useReviewSummary(issueId)
  const ci = review?.checks && review.checks.passed + review.checks.failed + review.checks.pending > 0 ? review.checks : null
  const counts = flow?.acceptance?.counts
  const evidenceTotal = (counts?.passed ?? 0) + (counts?.failed ?? 0) + (counts?.unverified ?? 0)
  const passed = results.filter(row => row.status === 'passed').length
  const failedChecks = results.filter(row => row.status === 'failed')
  const media = artifact?.media ?? []

  const changesHeader = <div className="flex items-center gap-2">
    <h3 className="text-md font-semibold">{t('changes')}</h3>
    {ready && <span className="text-sm text-muted-foreground">{t('files', { count: ready.files.length })}</span>}
    {ready && <Counts additions={ready.additions} deletions={ready.deletions} />}
    <span className="flex-1" />
    {ready && <Button variant="ghost" size="sm" onClick={() => { setAllChanges(!allChanges); setOpen(null) }}>{allChanges ? t('backToReview') : t('viewChanges')}<ChevronRight data-icon="inline-end" /></Button>}
  </div>
  const fileList = files.length > 0 && <div className="flex flex-col gap-2">{files.map(file => <FileSection key={file.path} file={file} wrap={wrap} ref={() => {}}
    open={opened.includes(file.path)} onOpenChange={next => setOpen(next ? [...opened, file.path] : opened.filter(path => path !== file.path))} />)}</div>
  const summary = delivery?.summary && <p className="text-sm whitespace-pre-wrap">{delivery.summary}</p>

  // P1b: the whole change set; the report's own text steps aside until 回到验收.
  if (allChanges) return <section data-changes-open aria-label={t('changes')} className="flex flex-col gap-4">{changesHeader}{summary}{fileList}</section>

  return <>
    {banner}
    <header className="flex flex-col gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-2xl font-semibold">
        {pr && <span className="flex size-5 shrink-0 [&_svg]:size-5"><PullRequestIcon state={pr.state} /></span>}
        <span className="min-w-0">{number ? t('cardTitle', { number, title: pr?.title ?? artifact?.title ?? '' }) : artifact?.title}</span>
      </h2>
      <div className="flex flex-wrap items-center gap-1.5">
        {flow?.acceptance && <CountBadges counts={flow.acceptance.counts} />}
        {results.filter(row => row.stage === 'review' && (row.status === 'passed' || row.status === 'failed')).map(row => <Badge key={row.stage} variant="outline" tone={row.status === 'passed' ? 'success' : 'warning'}>
          {row.status === 'passed' ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}{t(row.status === 'passed' ? 'reviewPassed' : 'reviewChanges')}
        </Badge>)}
      </div>
    </header>
    <section aria-label={t('pullRequest')} className="flex flex-col gap-1 rounded-xl bg-muted px-4 py-3">
      {delivery?.branch && <Row label={t('branch')} end={pr && <Button variant="ghost" size="xs" className="text-muted-foreground" nativeButton={false} render={<a href={pr.url} target="_blank" rel="noopener noreferrer" />}><span className="max-sm:sr-only">GitHub</span><ExternalLink data-icon="inline-end" /></Button>}>
        {/* The source branch gives way first; the target (main) stays whole, and on a phone GitHub keeps only its icon (UI audit task-23). */}
        <code className="truncate font-mono text-xs">{delivery.branch.head}</code>
        {delivery.branch.base && <><ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /><code className="shrink-0 font-mono text-xs">{delivery.branch.base}</code></>}
      </Row>}
      {(ci || results.length > 0 || sha) && <Row label={t('checks')} end={sha && <ShortSha sha={sha} />}>
        {ci ? <>
          {ci.failed ? <CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" /> : ci.pending ? <Spinner className="size-4 shrink-0 text-muted-foreground" /> : <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success-foreground" />}
          <span className={cn('shrink-0 text-xs font-medium tabular-nums', ci.failed ? 'text-destructive-foreground' : ci.pending ? 'text-muted-foreground' : 'text-success-foreground')}>{t('checksRatio', { passed: ci.passed, total: ci.passed + ci.failed + ci.pending })}</span>
          {(ci.failed > 0 || ci.pending > 0) && <span className="min-w-0 truncate text-xs text-muted-foreground">{ci.failed ? t('checksFailedNote', { count: ci.failed }) : t('checksPendingNote', { count: ci.pending })}</span>}
        </> : results.length > 0 && <>
          {failedChecks.length ? <CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" /> : results.every(row => row.status === 'passed') ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success-foreground" /> : <Spinner className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn('shrink-0 text-xs font-medium', failedChecks.length ? 'text-destructive-foreground' : 'text-success-foreground')}>{t('checksPassed', { passed, total: results.length })}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{results.map(row => t(row.stage)).join(' · ')}</span>
        </>}
      </Row>}
      {evidenceTotal > 0 && <Row label={t('evidence')}>
        <span className={cn('shrink-0 text-xs font-medium tabular-nums', counts?.failed ? 'text-destructive-foreground' : (counts?.passed ?? 0) === evidenceTotal ? 'text-success-foreground' : 'text-foreground')}>{t('evidenceRatio', { passed: counts?.passed ?? 0, total: evidenceTotal })}</span>
        {(counts?.unverified ?? 0) > 0 && <span className="min-w-0 truncate text-xs text-muted-foreground">{t('confirmUnverifiedCount', { count: counts?.unverified ?? 0 })}</span>}
      </Row>}
    </section>
    {(ready || summary) && <section aria-label={t('changes')} className="flex flex-col gap-4">{changesHeader}{summary}{fileList}</section>}
    {/* Every capture is shown here once: the report's text below embeds the same ones, and steps them aside (ArtifactDocument). */}
    {media.length > 0 && <section aria-label={t('evidence')} data-slot="report-evidence" className="flex flex-col gap-4">
      <h3 className="text-md font-semibold">{t('evidence')}</h3>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">{media.map(item => <li key={item.captureId} className="relative">
        <Button variant="ghost" className="h-auto w-full overflow-hidden rounded-xl bg-muted p-0" aria-label={item.title} onClick={() => setViewing(item)}>
          {item.kind === 'image'
            ? <img src={capturePath(item)} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover" />
            : <video src={capturePath(item)} preload="metadata" muted playsInline className="aspect-[4/3] w-full object-cover" />}
        </Button>
        {item.kind === 'video' && <Play aria-hidden="true" className="pointer-events-none absolute right-2 bottom-2 size-4 fill-current text-foreground" />}
      </li>)}</ul>
    </section>}
    <Dialog open={viewing !== null} onOpenChange={next => { if (!next) setViewing(null) }}>
      <DialogContent className="max-w-[min(64rem,calc(100vw-2rem))] p-2 sm:max-w-[min(64rem,calc(100vw-2rem))]">
        <DialogTitle className="sr-only">{viewing?.title}</DialogTitle>
        {viewing && (viewing.kind === 'image'
          ? <img src={capturePath(viewing)} alt={viewing.title} className="max-h-[80dvh] w-full rounded-lg object-contain" />
          : <video src={capturePath(viewing)} controls autoPlay playsInline className="max-h-[80dvh] w-full rounded-lg" />)}
      </DialogContent>
    </Dialog>
  </>
}

/** A state stated first in the report (P3, P7, P7b): what happened, the detail under it, and what to do next. */
export function ReportBanner({ tone, icon, title, detail, children }: { tone: 'muted' | 'destructive'; icon: ReactNode; title: string; detail?: string | null; children?: ReactNode }) {
  return <div role={tone === 'destructive' ? 'alert' : 'status'} data-slot="report-banner" className={cn('flex min-w-0 items-center gap-3 rounded-xl px-4 py-3', tone === 'destructive' ? 'bg-destructive/10' : 'bg-muted')}>
    <span className={cn('flex size-4 shrink-0 [&_svg]:size-4', tone === 'destructive' && 'text-destructive-foreground')}>{icon}</span>
    <div className="flex min-w-0 flex-1 flex-col">
      <p className={cn('truncate text-sm font-medium', tone === 'destructive' && 'text-destructive-foreground')}>{title}</p>
      {detail && <p className="truncate text-xs">{detail}</p>}
    </div>
    {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
  </div>
}

/**
 * The PR report above the report's text in the Artifact window (P1, P3, P6, P7, P7b), read-only. It follows
 * the task's state from the shared detail, flow and ledger reads, so it stays while a fix run or failed checks
 * unbind the decision; a bound decision puts its own buttons into the banner through `onBannerSlot`.
 */
export function ArtifactReportLead({ task, artifactId, onBannerSlot, actions: header }: { task: FactoryTask; artifactId: string; onBannerSlot: (node: HTMLElement | null) => void; /** The window header's action area: a fix run names itself there (P3), with nothing to decide. */ actions?: HTMLElement | null }) {
  const t = useTranslations('ArtifactReview')
  const tAcceptance = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const { kind, detail, flow, ledger, merge, pullRequest } = useArtifactReview(task.id, { hasArtifact: true, runSucceeded: true })
  // A v2 report draws its lead only while it is the task's report; an older task has no flow to say so.
  if (!detail || (isFlowV2(detail) && flow?.acceptance?.artifactId !== artifactId)) return null
  const checks = (Array.isArray(detail.checks) ? detail.checks : []).filter(check => !isFlowV2(detail) || check.runId !== null)
  const results = resultRows(checks, detail.task?.candidateId ?? null)
  const failed = results.filter(row => row.status === 'failed')
  const rejected = ledger?.rejections?.at(-1)
  const time = (iso: string) => format.dateTime(new Date(iso), { hour: '2-digit', minute: '2-digit' })
  const actions = <span ref={onBannerSlot} className="flex items-center gap-2 empty:hidden" />
  const github = pullRequest && <Button size="sm" variant="secondary" nativeButton={false} render={<a href={pullRequest.url} target="_blank" rel="noopener noreferrer" />}>{tAcceptance('openOnGitHub')}</Button>
  const banner = kind === 'fixing' ? <ReportBanner tone="muted" icon={<Spinner />} title={rejected ? t('changesRequestedAt', { time: time(rejected.createdAt) }) : t('state.fixing')} detail={rejected?.note} />
    : kind === 'refused' && merge?.refusal ? <ReportBanner tone="destructive" icon={<CircleX aria-hidden="true" />} title={t('mergeFailed', { reason: tAcceptance(`mergeRefusal.${merge.refusal}` as 'mergeRefusal.githubUnavailable') })}>{actions}</ReportBanner>
    : kind === 'blocked' || failed.length ? <ReportBanner tone="destructive" icon={<CircleX aria-hidden="true" />} title={failed.length ? t('checksFailed', { names: failed.map(row => t(row.stage)).join(' · ') }) : t('state.blocked')} detail={detail.task?.reason || null}>
      {github}{actions}
    </ReportBanner> : undefined
  // The changes are the candidate's work tree; during a fix run that is still the PR's last candidate.
  return <>
    {header && kind === 'fixing' && createPortal(<span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Spinner />{t('state.fixing')}</span>, header)}
    <AcceptanceReport artifactId={artifactId} issueId={task.issueId} runId={task.candidateRunId ?? flow?.acceptance?.runId ?? null} detail={detail} flow={flow} results={results} banner={banner} />
  </>
}
