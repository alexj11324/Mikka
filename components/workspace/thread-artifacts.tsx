'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronRight, ClipboardList, FileText, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listRunArtifacts, listTaskArtifacts } from '@/app/actions/artifacts'
import { withBasePath } from '@/lib/base-path'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { InlineLoadError } from '@/components/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { readAccessFailure } from '@/lib/swr/persistent-cache'
import { RequestError } from '@/lib/factory/browser-request'
import { PULL_REQUEST_COLORS, PULL_REQUEST_ICONS } from '@/lib/pull-request-appearance'
import { readTaskEvidenceTarget } from '@/lib/task-factory-events'
import { THREAD_ARTIFACT_GROUPS, threadArtifactCount, threadArtifacts, type RunCaptureRef, type RunArtifactRef, type ThreadArtifactItem } from '@/lib/thread-artifacts'
import { useIssueThreads } from './issue-threads'
import { EvidenceViewer } from './factory-evidence'
import { pullRequestRef } from './pull-requests-badge'
import { openArtifact } from './workspace-navigation'

type RunEvidence = { captures: RunCaptureRef[]; artifacts: RunArtifactRef[] }

/** A thread without a Factory task reads what its runs produced from the existing owner-only evidence route; another person's run reads as none. */
async function readRunEvidence(runIds: readonly string[]): Promise<RunEvidence> {
  const reads = await Promise.all(runIds.map(async runId => {
    const response = await fetch(withBasePath(`/api/runs/${encodeURIComponent(runId)}/evidence`), { cache: 'no-store' })
    if (response.status === 404 || response.status === 401) return { captures: [], artifacts: [] }
    if (!response.ok) throw new RequestError('runEvidenceUnavailable', response.status, {})
    const body = await response.json() as Partial<RunEvidence>
    return { captures: Array.isArray(body.captures) ? body.captures : [], artifacts: Array.isArray(body.artifacts) ? body.artifacts : [] }
  }))
  return { captures: reads.flatMap(read => read.captures), artifacts: reads.flatMap(read => read.artifacts) }
}

/**
 * What a thread's Artifact tab lists (Alex, 2026-11-15, as Warp's run page). A Factory task's conversation shows the
 * task's receipts from the task's own work read (shared with the task conversation, so no new request there); a review
 * or verify thread shows only its own runs' receipts. A thread with no Factory task reads its runs' evidence.
 */
type ThreadArtifactsProps = { issueId: string | null; runId: string; runIds: readonly string[]; conversation: boolean; status: string }
export type ThreadArtifactsRead = ReturnType<typeof useThreadArtifacts>

function useThreadArtifacts({ issueId, runId, runIds: listed, conversation, status }: ThreadArtifactsProps) {
  const runKey = listed.join(',')
  const runIds = useMemo(() => runKey.split(',').filter(Boolean), [runKey])
  const work = useIssueThreads(issueId ?? '', Boolean(issueId))
  const factory = work.work?.factory ?? null
  const workRead = !issueId || work.work !== undefined || Boolean(work.error)
  const evidenceRuns = workRead && !factory ? runIds : []
  const evidence = useSWR(evidenceRuns.length ? ['run-evidence', status, ...evidenceRuns] : null, () => readRunEvidence(evidenceRuns), { revalidateOnFocus: false, shouldRetryOnError: false })
  // The header's Artifact button holds the same read and refreshes it when the run's state changes.
  const { data: runArtifacts } = useSWR(['run-artifacts', runId], () => listRunArtifacts(runId), { dedupingInterval: 0 })
  const pullRequests = work.work?.presentation?.pullRequests
  const groups = useMemo(() => threadArtifacts({
    factory: factory?.artifacts ?? null,
    runIds: conversation ? null : runIds,
    pullRequests: conversation && factory ? pullRequests ?? [] : [],
    runArtifacts: [...runArtifacts ?? [], ...evidence.data?.artifacts ?? []],
    captures: evidence.data?.captures ?? [],
  }), [factory, conversation, runIds, pullRequests, runArtifacts, evidence.data])
  // An evidence link (`?issue=…&factoryTask=…&evidence=…`) names one receipt of this task's Factory work.
  const target = readTaskEvidenceTarget(useSearchParams() ?? new URLSearchParams())
  const focusId = target && target.issueId === issueId && factory?.task.id === target.factoryTaskId &&
    THREAD_ARTIFACT_GROUPS.some(group => groups[group].some(item => item.id === target.receiptId)) ? target.receiptId : null
  const documents = useMemo(() => {
    const admitted = threadArtifacts({ factory: factory?.artifacts ?? null, runIds, runArtifacts: evidence.data?.artifacts })
    return [...admitted.plans, ...admitted.reports].flatMap(item => ('artifactId' in item && item.title)
      ? [{ id: item.artifactId, title: item.title, latestVersion: item.version }] : [])
  }, [factory, runIds, evidence.data])
  return { groups, documents, count: threadArtifactCount(groups), focusId, factoryTaskId: factory?.task.id ?? null }
}

/** Loads contextual evidence for the primary thread pane. */
export function ThreadArtifactsReader({ onRead, ...props }: ThreadArtifactsProps & { onRead: (read: ThreadArtifactsRead) => void }) {
  const read = useThreadArtifacts(props)
  const report = useRef(onRead)
  report.current = onRead
  // Report what changed, not each render's new arrays: the panel holds the read as state.
  const signature = JSON.stringify([read.groups, read.documents, read.focusId, read.factoryTaskId])
  useEffect(() => { report.current(read) }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export function TaskArtifactsButton({ issueId, threads, work, failed }: { issueId: string; threads: readonly import('@/lib/issue-threads').IssueThread[]; work: ReturnType<typeof useIssueThreads>['work']; failed: (() => void) | null }) {
  const t = useTranslations('ArtifactsPage')
  const title = useTranslations('Nav')('artifacts')
  const [open, setOpen] = useState(false)
  const documents = useSWR(open ? ['task-artifacts', issueId] : null, () => listTaskArtifacts(issueId), { revalidateOnFocus: false })
  const runs = [...new Set(threads.filter(thread => thread.detail).flatMap(thread => [thread.id, ...thread.attempts.map(attempt => attempt.runId)]))].sort()
  const evidence = useSWR(open && work && runs.length ? ['task-artifact-evidence', issueId, ...runs] : null,
    () => readRunEvidence(runs), { revalidateOnFocus: false })
  const refused = readAccessFailure(documents.error) || readAccessFailure(evidence.error)
  const groups = threadArtifacts({ factory: refused ? null : work?.factory?.artifacts ?? null, runIds: null,
    pullRequests: refused ? [] : work?.presentation?.pullRequests ?? [],
    runArtifacts: refused ? [] : [...documents.data ?? [], ...evidence.data?.artifacts ?? []], captures: refused ? [] : evidence.data?.captures })
  const hasError = documents.error || evidence.error || failed
  const loading = !documents.data || work === undefined || evidence.isLoading
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button variant="ghost" size="sm" data-slot="task-artifacts-button" />}><ArtifactIcon data-icon="inline-start" />{title}</DialogTrigger>
    <DialogContent className="flex max-h-[80dvh] flex-col sm:max-w-xl">
      <DialogTitle>{title}</DialogTitle>
      {hasError && <InlineLoadError message={t('loadError')} retryLabel={t('retry')} onRetry={() => { failed?.(); void documents.mutate(); void evidence.mutate() }} />}
      {threadArtifactCount(groups) > 0 ? <ThreadArtifactsPane groups={groups} focusId={null} mediaTaskId={work?.factory?.task.id ?? issueId} onOpenDocument={() => setOpen(false)} />
        : !hasError && (loading ? <div role="status" aria-label={t('loading')}><Skeleton className="h-10 w-full" /></div>
          : <p role="status" className="text-muted-foreground">{t('empty')}</p>)}
    </DialogContent>
  </Dialog>
}

const ROW = 'h-auto w-full min-w-0 justify-start gap-3 rounded-lg px-2 py-2 text-left font-normal whitespace-normal data-[focused=true]:bg-muted'

const GROUP_LABEL = { plans: 'plans', pullRequests: 'pullRequests', reports: 'reports', captures: 'captures' } as const

/** The Artifact tab's pane: 方案, PR, 报告, 截图和录屏, each with its count; an empty group is left out. */
export function ThreadArtifactsPane({ groups, focusId, mediaTaskId, onOpenDocument }: { groups: ReturnType<typeof threadArtifacts>; focusId: string | null; mediaTaskId: string; onOpenDocument?: () => void }) {
  const t = useTranslations('IssueThreads.artifacts')
  const tState = useTranslations('Metadata.prState')
  const tKind = useTranslations('FactoryAcceptance.kind')
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  useEffect(() => {
    if (!focusId || focused.current === focusId) return
    const control = root.current?.querySelector<HTMLElement>(`[data-artifact-item="${CSS.escape(focusId)}"]`)
    if (control) { focused.current = focusId; control.scrollIntoView({ block: 'nearest' }); control.focus({ preventScroll: true }) }
  }, [focusId])
  const captures = groups.captures.filter((item): item is Extract<ThreadArtifactItem, { group: 'captures' }> => item.group === 'captures')
  const captureLabel = (item: (typeof captures)[number]) => item.title?.trim() || tKind(item.kind === 'image' ? 'screenshot' : 'video')
  return <div ref={root} data-slot="thread-artifacts" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
    {THREAD_ARTIFACT_GROUPS.filter(group => groups[group].length).map(group => <section key={group} aria-labelledby={`thread-artifacts-${group}`} data-artifact-group={group} className="flex flex-col gap-1">
      <h3 id={`thread-artifacts-${group}`} className="flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
        {t(GROUP_LABEL[group])}<span className="tabular-nums">{groups[group].length}</span>
      </h3>
      {group === 'captures'
        ? <ul className="grid grid-cols-3 gap-2 px-2 pt-1">{captures.map((item, index) => <li key={item.id}>
          <Button variant="ghost" data-artifact-item={item.id} data-focused={item.id === focusId} aria-label={t('open', { title: captureLabel(item) })} onClick={() => setViewing(index)}
            className="relative aspect-video h-auto w-full overflow-hidden rounded-lg bg-muted p-0 data-[focused=true]:ring-2 data-[focused=true]:ring-ring">
            {item.kind === 'image' || item.posterUrl
              ? <img src={item.kind === 'image' ? item.url : item.posterUrl ?? undefined} alt="" loading="lazy" draggable={false} className="size-full object-cover object-top" />
              : null}
            {item.kind === 'video' && <span className="absolute flex size-6 items-center justify-center rounded-full bg-background text-foreground"><Play data-icon="inline-start" aria-hidden="true" className="fill-current" /></span>}
          </Button>
        </li>)}</ul>
        : <ul className="flex flex-col">{groups[group].map(item => <li key={item.id}>
          {item.group === 'pullRequests' ? <PullRow item={item} focused={item.id === focusId} stateLabel={item.state ? tState(item.state) : null} />
            : item.group !== 'captures' && <Button variant="ghost" data-artifact-item={item.id} data-focused={item.id === focusId} className={ROW} onClick={() => { onOpenDocument?.(); openArtifact(item.artifactId) }}>
              {item.group === 'plans' ? <ClipboardList data-icon="inline-start" aria-hidden="true" className="text-muted-foreground" /> : <FileText data-icon="inline-start" aria-hidden="true" className="text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate text-sm">{item.title || tKind('report')}</span>
              {item.version !== null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">v{item.version}</span>}
              <ChevronRight data-icon="inline-end" aria-hidden="true" className="text-muted-foreground rtl:rotate-180" />
            </Button>}
        </li>)}</ul>}
    </section>)}
    {viewing !== null && captures[viewing] && <EvidenceViewer taskId={mediaTaskId} index={viewing} title={captureLabel(captures[viewing])}
      items={captures.map(item => ({ command: null, entry: { artifact: item.id, kind: item.kind === 'image' ? 'screenshot' : 'video', stage: 'execute', captureId: item.id,
        title: captureLabel(item), ...(item.contentType ? { contentType: item.contentType } : {}), durationMs: item.durationMs } }))}
      mediaSource={entry => captures.find(item => item.id === entry.artifact)?.url ?? null}
      readText={() => Promise.reject(new Error('threadArtifactNotText'))}
      onIndex={setViewing} onClose={() => setViewing(null)} />}
  </div>
}

/** As Capy's PR line (issue-view PullValueRow): the state's coloured mark, repo#n quiet, then the title — no state word. */
function PullRow({ item, focused, stateLabel }: { item: Extract<ThreadArtifactItem, { group: 'pullRequests' }>; focused: boolean; stateLabel: string | null }) {
  const { repo, number } = pullRequestRef(item.url)
  const Icon = PULL_REQUEST_ICONS[item.state ?? 'open']
  return <Button variant="ghost" nativeButton={false} data-artifact-item={item.id} data-focused={focused} className={ROW}
    render={<a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={[stateLabel, `${repo}#${number}`, item.title].filter(Boolean).join(' ')} />}>
    <Icon data-icon="inline-start" aria-hidden="true" className={PULL_REQUEST_COLORS[item.state ?? 'open']} />
    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{repo}#{number}</span>
    {item.title && <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>}
  </Button>
}
