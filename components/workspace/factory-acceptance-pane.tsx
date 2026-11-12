'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useSWR, { useSWRConfig } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { useFormatter, useTranslations } from 'next-intl'
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Cloud, ExternalLink, Laptop, RefreshCw, Server } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useViewState } from '@/lib/hooks/view-state'
import { cn } from '@/lib/utils'
import type { PublicationEnvironment } from '@/lib/factory/vercel-target'
import { acceptanceState, flowMergeAcceptance, mergeAcceptance, type AcceptanceMerge, type AcceptanceState } from '@/lib/factory/acceptance-state'
import { canReject, closedReject, rejectFlow } from '@/lib/factory/reject-flow'
import { evidenceEntries, orderEvidence, type EvidenceEntry } from '@/lib/factory/evidence-view'
import { bareUrl, candidateCheckRetry, candidateCheckRetryConfirmed, candidateCheckState, candidateRecheck, candidateRecheckConfirmed, criterionGroups, pullNumber, resultRows, type AcceptanceDetail, type CriterionGroup, type ResultRow } from '@/lib/factory/acceptance-view'
import { CriterionEvidence, EvidenceViewer } from './factory-evidence'
import { ApprovalBar } from './factory-approval-bar'
import { RejectNote } from './factory-reject-note'
import { PullRequestIcon } from './pull-request-icon'
import { ShortSha, shortSha } from './short-sha'
import { FieldError } from '@/components/ui/field'
import { RunErrorDetails } from './run-error-text'
import { RequestError, request } from '@/lib/factory/browser-request'
import { isFlowV2, useFactoryFlow } from './factory-flow'
import { artifactReviewKind, pullNumberOf } from '@/lib/factory/artifact-review'
import type { ArtifactDecisionSlots } from '@/components/artifacts/artifact-viewer'

export { RequestError, request } from '@/lib/factory/browser-request'

type Candidate = { sha: string | null; kind?: 'repository' | 'report' | 'deliverable'; repository: string; environment: string; scope: string }
export type FactoryTask = { id: string; issueId: string; stage: string; status: string; reason: string; candidateId: string | null; candidateRunId: string | null; isSkillCandidate: boolean; revision?: number; attemptId?: string; completionRecovery?: AcceptanceDetail['completionRecovery'] }
type Evidence = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; manifest: { candidate: Candidate; artifacts: EvidenceEntry[] } }
type Approval = { id: string; candidateId: string; candidate: Candidate; action: string; target: string; targetEnvironment: string; expiresAt: string; revokedAt: string | null; createdAt: string }
type Publication = { id: string; approvalId: string; status: 'reserved' | 'uncertain' | 'succeeded' | 'failed'; request: Record<string, unknown>; receipt?: { verifiedTarget?: { reference?: string } } }
type Ledger = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; approvals: Approval[]; publications: Publication[]; merges?: (AcceptanceMerge & { finishedAt?: string | null })[]; rejections?: { note: string | null; createdAt: string }[]; capabilities?: { reject?: boolean } }

const environmentOf = (candidate: Candidate | undefined): PublicationEnvironment | null =>
  candidate?.environment === 'production' ? 'production' : candidate?.environment === 'preview' ? 'preview' : null

type ErrorKey = 'error' | 'decisionUnavailable' | 'publicationUnavailable' | 'attestationRequired'
const ERROR_KEYS: Record<string, ErrorKey> = {
  factoryPolicyDecisionUnavailable: 'decisionUnavailable',
  factoryPublicationUnavailable: 'publicationUnavailable',
  factoryPolicyAttestationRequired: 'attestationRequired',
}

/** The approve call still takes an expiry until #517 lands; approving publishes at once, so the bar shows none. */

/** GitHub's refusals of a merge (#528): the task keeps waiting, and the person can open the PR on GitHub. */
const MERGE_REFUSALS = new Set(['githubMergeAuthorizationRequired', 'githubMergeForbidden', 'githubMergeBlocked', 'githubMergeConflict', 'githubMergeHeadMoved', 'githubMergeClosed', 'githubUnavailable'])
type Derived = { state: AcceptanceState; active?: unknown; publication?: unknown; superseded?: unknown; refusal?: string }

/** v2 consumers share the public flow; the ledger still binds candidate operations. */
export function useAcceptance(task: FactoryTask) {
  const ledgerKey = `/api/factory/tasks/${task.id}/approval?view=ledger`
  const detailKey = `/api/factory/tasks/${task.id}`
  const { data: ledger, mutate: reload, error: ledgerError } = useSWR<Ledger>(ledgerKey, request, { refreshInterval: 0 })
  const { data: detail, error: detailError } = useSWR<AcceptanceDetail>(detailKey, request, { refreshInterval: 0 })
  useLiveKey('factory_task', task.id, [ledgerKey, detailKey], detail?.liveWorkspaceId ?? null)
  const v2 = isFlowV2(detail)
  const { flow, error: flowError, mutate: reloadFlow } = useFactoryFlow(task.id, detail, v2)
  // The list refreshes while a recovered candidate passes its checks. An
  // older cached detail with that same candidate must not hide newer approval.
  const current = detail?.task && detail.task.candidateId === task.candidateId &&
    (typeof task.revision !== 'number' || (typeof detail.task.revision === 'number' && detail.task.revision >= task.revision)) ? detail.task : task
  const derived: Derived | undefined = !ledger ? undefined : task.isSkillCandidate
    ? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals: Array.isArray(ledger.approvals) ? ledger.approvals : [], publications: Array.isArray(ledger.publications) ? ledger.publications : [], now: Date.now() })
    : v2 ? flowMergeAcceptance({ flow, candidateId: current.candidateId, merges: Array.isArray(ledger.merges) ? ledger.merges : [] })
      : mergeAcceptance({ stage: current.stage, status: current.status, candidateId: current.candidateId, merges: Array.isArray(ledger.merges) ? ledger.merges : [] })
  const check = task.completionRecovery || detail?.completionRecovery ? null : candidateCheckState(current)
  return { ledger, reload, ledgerError, derived, check, current, detailLoaded: detail !== undefined, detailError, v2, flow, flowError, reloadFlow }
}

function Label({ children }: { children: string }) {
  return <span className="w-20 shrink-0 text-xs text-muted-foreground">{children}</span>
}

/** Frame 06 「候选」: the PR, the commit, the preview and where it runs. */
function CandidateCard({ candidate, detail, environment, isSkill }: { candidate?: Candidate; detail?: AcceptanceDetail; environment: string | null; isSkill: boolean }) {
  const t = useTranslations('FactoryAcceptance')
  const delivery = detail?.delivery
  const pr = delivery?.pullRequest
  const number = pr ? pullNumber(pr.url) : null
  const sha = candidate?.sha ?? delivery?.candidateSha ?? undefined
  const repository = candidate?.repository ?? delivery?.repository
  const sourceEnvironment = candidate?.environment ?? delivery?.environment
  const runtimeEnvironment = isSkill ? t('internalSkill') : environment ?? (sourceEnvironment?.startsWith('device:')
    ? delivery?.machine?.name ?? delivery?.machineName ?? t(delivery?.machine?.kind === 'cloud' ? 'envChip.cloud' : 'envChip.device')
    : sourceEnvironment)
  return <section aria-label={t('candidate')} className="flex flex-col gap-2 rounded-xl bg-muted px-4 py-3.5">
    {pr && <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="flex size-4 shrink-0 [&_svg]:size-4"><PullRequestIcon state={pr.state} /></span>
      <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0 font-medium hover:underline">{number ? `#${number}` : t('pullRequest')}</a>
      {pr.title ? <span className="min-w-0 truncate">{pr.title}</span> : repository && <span className="min-w-0 truncate text-muted-foreground">{repository}</span>}
    </div>}
    {sha && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('commitLabel')}</Label>
      <ShortSha sha={sha} icon />
      {!pr && repository && <span className="min-w-0 truncate text-xs text-muted-foreground">{repository}</span>}
    </div>}
    {delivery?.previewUrl && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('previewLabel')}</Label>
      <a href={delivery.previewUrl} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 text-sm hover:underline">
        <span className="truncate">{bareUrl(delivery.previewUrl)}</span><ExternalLink aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </a>
    </div>}
    {runtimeEnvironment && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('environmentLabel')}</Label>
      <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm">{runtimeEnvironment}{!isSkill && delivery?.previewDatabaseBranch && ` · Neon ${delivery.previewDatabaseBranch}`}</span>
    </div>}
    {isSkill && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('target')}</Label>
      <code className="truncate text-xs">mikka-builtin:run-report</code>
    </div>}
  </section>
}

/** Frame 06 header: the machine that produced the candidate. Reads the same task detail as the pane. */
export function CandidateMachine({ taskId }: { taskId: string }) {
  const key = `/api/factory/tasks/${taskId}`
  const { data } = useSWR<AcceptanceDetail>(key, request, { refreshInterval: 0 })
  useLiveKey('factory_task', taskId, [key], data?.liveWorkspaceId ?? null)
  const machine = data?.delivery?.machine
  if (!machine?.name) return null
  const Icon = machine.kind === 'cloud' ? Cloud : Laptop
  return <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground max-sm:hidden">
    <Icon aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{machine.name}</span>
  </span>
}

function Verdict({ passed }: { passed: boolean | null }) {
  if (passed === null) return <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
  return passed ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success-foreground" /> : <CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" />
}

/** Figma `Factory/CriterionRow`: the criterion, its result, and the evidence that shows it. */
function CriterionRow({ taskId, group, onOpen }: { taskId: string; group: CriterionGroup; onOpen: (index: number) => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <li className="flex flex-col gap-2 rounded-xl px-3 pt-2.5 pb-3">
    <div className="flex min-w-0 items-center gap-2">
      {group.title !== null && <Verdict passed={group.passed} />}
      <h5 className={cn('min-w-0 flex-1 text-sm', group.title === null ? 'text-xs text-muted-foreground' : 'font-medium')}>{group.title ?? t('otherEvidence')}</h5>
      {group.title !== null && group.passed !== null && <span className={cn('shrink-0 text-xs', group.passed ? 'text-success-foreground' : 'text-destructive-foreground')}>{t(group.passed ? 'passed' : 'notPassed')}</span>}
    </div>
    {group.items.length > 0 && <div className={cn(group.title !== null && 'pl-6')}><CriterionEvidence taskId={taskId} items={group.items} onOpen={onOpen} /></div>}
  </li>
}

const RESULT_WORD = { review: { passed: 'reviewPassed', failed: 'reviewFailed' }, verify: { passed: 'passed', failed: 'notPassed' } } as const

/** Figma `Factory/ResultRow`: the independent review or verify, its verdict and its thread. */
function ResultLine({ row, onOpenThread }: { row: ResultRow; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const done = row.status === 'passed' || row.status === 'failed'
  const blocked = row.status === 'blocked'
  const word = row.status === 'passed' || row.status === 'failed' ? t(RESULT_WORD[row.stage][row.status]) : t(blocked ? 'blocked' : 'inProgress')
  const meta = row.stage === 'verify' ? (row.total ? `${row.passed}/${row.total}` : null) : row.total - row.passed > 0 ? t('opinions', { count: String(row.total - row.passed) }) : null
  const thread = t(row.stage === 'review' ? 'reviewThread' : 'verifyThread')
  return <li className="flex min-h-10 min-w-0 flex-wrap items-center gap-2 rounded-xl px-3 py-2.5">
    {done ? <Verdict passed={row.status === 'passed'} /> : blocked ? <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" /> : <Spinner className="size-4 shrink-0 text-muted-foreground" />}
    <span className="text-sm font-medium">{t(row.stage === 'review' ? 'review' : 'verify')}</span>
    <span className={cn('text-sm', row.status === 'passed' ? 'text-success-foreground' : row.status === 'failed' || blocked ? 'text-destructive-foreground' : 'text-muted-foreground')}>{word}</span>
    {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
    <span className="flex-1" />
    {row.runId && onOpenThread
      ? <Button variant="secondary" size="xs" onClick={() => onOpenThread(row.runId!)}><Verdict passed={done ? row.status === 'passed' : null} />{thread}</Button>
      : <span className="text-xs text-muted-foreground">{thread}</span>}
    {row.sha && <span className="font-mono text-xs text-muted-foreground">{shortSha(row.sha)}</span>}
    {row.commandSources?.map(source => <div key={`${source.runId}:${source.recoveryEventId}`} className="flex w-full min-w-0 flex-wrap items-center gap-2 pl-6 text-xs text-muted-foreground">
      <span>{t('questionCommandSource')}</span>
      <time dateTime={source.observedAt}>{format.dateTime(new Date(source.observedAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      {onOpenThread && <Button variant="secondary" size="xs" onClick={() => onOpenThread(source.runId)}>{t('sourceExecution')}</Button>}
    </div>)}
  </li>
}

/**
 * The 验收 tab (Figma 357:4750, frame 06; phone 365:12779): the candidate,
 * each acceptance criterion with its evidence, the independent results, and
 * the decision bar pinned to the bottom. Approve, publish, reconcile, revoke
 * and send-back are the A1/A2 operations on the approval route.
 */
export function FactoryAcceptancePane({ task, onOpenThread, artifactBinding, artifact }: { task: FactoryTask; onOpenThread?: (runId: string) => void; artifactBinding?: { candidateId: string; revision: number }; /** Inside the Artifact window (P1–P7b): the report, the header actions and 要求修改 in the thread's composer. */ artifact?: ArtifactReviewSlots }) {
  const t = useTranslations('FactoryAcceptance')
  const tReview = useTranslations('ArtifactReview')
  const format = useFormatter()
  const [confirming, setConfirming] = useState(false)
  const { mutate: mutateCache } = useSWRConfig()
  const { ledger, reload, ledgerError, derived: acceptance, check, current: currentTask, detailLoaded, detailError, v2, flow, flowError, reloadFlow } = useAcceptance(task)
  // A voided approval puts the task back to pending, so the current candidate's evidence is needed to enable it again.
  const needsEvidence = v2 ? flow?.stage === 'handoff' || flow?.stage === 'completed' : task.stage === 'approval' || Boolean(acceptance?.superseded) || acceptance?.state === 'merged'
  const { data: evidence, error: evidenceReadError } = useSWR<Evidence>(needsEvidence ? `/api/factory/tasks/${task.id}/approval` : null, request)
  // A candidate whose review has not passed has no evidence yet (409): the pane shows none instead of failing to load.
  const evidenceMissing = evidenceReadError instanceof RequestError && evidenceReadError.status === 409
  const evidenceError = evidenceMissing ? undefined : evidenceReadError
  // Checks and the delivery header (B8/B9/B11) are read-only extras; the pane works without them.
  const { data: detail, mutate: reloadDetail } = useSWR<AcceptanceDetail>(`/api/factory/tasks/${task.id}`, request)
  useLiveKey('factory_task', task.id, needsEvidence ? [`/api/factory/tasks/${task.id}/approval`] : [], detail?.liveWorkspaceId ?? null)
  const detailRevision = detail?.task?.revision
  useEffect(() => {
    if (typeof task.revision === 'number' && typeof detailRevision === 'number' && detailRevision < task.revision)
      void reloadDetail().catch(() => {})
  }, [task.revision, detailRevision, reloadDetail])
  const [busy, setBusy] = useState(false)
  const deciding = useRef(false)
  const retrying = useRef(false)
  const completionRequest = useRef<{ revision: number; eventId: string } | null>(null)
  const [activation, setActivation] = useViewState<{ revision: number; candidateId: string | null; eventId: string } | null>(`factory:${task.id}:activation`, null)
  const [checkRequest, setCheckRequest] = useViewState<{ key: string; eventId: string; reason: string } | null>(`factory:${task.id}:check-retry`, null)
  const [checkError, setCheckError] = useState<{ key: string; unknown: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ group: number; index: number } | null>(null)
  const [reject, dispatchReject] = useReducer(rejectFlow, closedReject)
  // A refusal with no recorded attempt (no GitHub authorization) lives only in this pane.
  const [refused, setRefused] = useState<string | null>(null)

  const approvals = ledger && Array.isArray(ledger.approvals) ? ledger.approvals : []
  const latest = approvals[approvals.length - 1]
  const derived: Derived = acceptance ?? (v2 ? { state: 'unavailable' } : task.isSkillCandidate ? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals, publications: [], now: Date.now() }) : mergeAcceptance({ stage: task.stage, status: task.status, candidateId: task.candidateId, merges: [] }))
  const state = derived.state
  const active = derived.active as Approval | undefined
  const publication = derived.publication as Publication | undefined
  const superseded = derived.superseded as Approval | undefined
  // Only an approval on the current candidate may describe it; a voided one carries the old sha.
  const current = latest && latest.candidateId === task.candidateId ? latest : undefined
  const candidate = evidence?.manifest?.candidate ?? active?.candidate ?? current?.candidate
  const environment = environmentOf(candidate)
  const reference = publication?.receipt?.verifiedTarget?.reference
  const checks = Array.isArray(detail?.checks) ? detail.checks.filter(item => !v2 || item.runId !== null) : []
  const pullRequestUrl = detail?.delivery?.pullRequest?.url ?? null
  const refusal = state === 'pending' ? refused ?? derived.refusal ?? null : null
  const retryCheck = candidateCheckRetry(task, detail, ledger?.binding)
  const recheck = candidateRecheck(task, detail, ledger?.binding)
  // A late ledger or evidence response must never attach new decision power
  // to the report version the person was reading before a repair.
  const reportCurrent = !artifactBinding || (detail?.task?.id === task.id && detail.task.issueId === task.issueId &&
    detail.task.candidateId === artifactBinding.candidateId && detail.task.revision === artifactBinding.revision &&
    [ledger?.binding, evidence?.binding].every(binding => binding?.taskId === task.id && binding.issueId === task.issueId &&
      binding.candidateId === artifactBinding.candidateId && binding.revision === artifactBinding.revision) &&
    ledger?.binding.attemptId === evidence?.binding.attemptId && ledger?.binding.attemptId === detail.task.attemptId)

  async function reloadDecision() {
    await Promise.allSettled([reload(), reloadDetail(), mutateCache(`/api/factory/tasks/${task.id}/approval`), mutateCache(`/api/factory/tasks?issueId=${encodeURIComponent(task.issueId)}`),
      ...(v2 ? [reloadFlow()] : [])])
  }

  async function run(operation: 'approve' | 'publish' | 'reconcile' | 'revoke', input: Record<string, unknown>) {
    if (deciding.current) return
    deciding.current = true
    setBusy(true)
    setError(null)
    try {
      await request(`/api/factory/tasks/${task.id}/approval`, { operation, input })
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.code : 'factoryUnavailable')
    } finally {
      await reloadDecision()
      deciding.current = false
      setBusy(false)
    }
  }

  async function retryCompletion() {
    const recovery = detail?.completionRecovery
    if (!recovery || retrying.current) return
    retrying.current = true; setBusy(true); setError(null)
    if (completionRequest.current?.revision !== recovery.binding.revision) completionRequest.current = { revision: recovery.binding.revision, eventId: crypto.randomUUID() }
    try {
      await request(`/api/factory/tasks/${task.id}`, { binding: recovery.binding, eventId: completionRequest.current.eventId, action: 'retry', reason: 'Resume the completed execution' })
    } catch (caught) { setError(caught instanceof RequestError ? caught.code : 'factoryUnavailable') }
    finally {
      await Promise.all([reload().catch(() => {}), reloadDetail().catch(() => {}), ...(v2 ? [reloadFlow().catch(() => {})] : [])])
      retrying.current = false; setBusy(false)
    }
  }

  async function retryCandidateCheck(rechecking = false) {
    const retryCheck = rechecking ? recheck : candidateCheckRetry(task, detail, ledger?.binding)
    if (!retryCheck || retrying.current || busy) return
    retrying.current = true; setBusy(true); setError(null); setCheckError(null)
    // A lost response keeps this event id. Only a later explicit click on a
    // newly bound attempt can create another request; refresh never sends one.
    const submission = checkRequest?.key === retryCheck.key ? checkRequest
      : { key: retryCheck.key, eventId: crypto.randomUUID(), reason: t(retryCheck.stage === 'review' ? 'retryReview' : 'retryVerify') }
    setCheckRequest(submission)
    try {
      const result = await request(`/api/factory/tasks/${task.id}`, { binding: retryCheck.binding, eventId: submission.eventId,
        action: rechecking ? 'recheck' : 'retry', reason: submission.reason })
      const confirmed = rechecking ? candidateRecheckConfirmed(task, result)
        : candidateCheckRetryConfirmed({ ...task, route: detail?.task?.route }, result, detail?.checkStartRecovery, detail?.checkDispatchRecovery, detail?.checkSubmissionRecovery)
      if (!confirmed) setCheckError({ key: retryCheck.key, unknown: true })
    } catch (caught) {
      setCheckError({ key: retryCheck.key, unknown: !(caught instanceof RequestError) || caught.status >= 500 })
    } finally {
      await Promise.all([reload().catch(() => {}), reloadDetail().catch(() => {}), ...(v2 ? [reloadFlow().catch(() => {})] : []),
        mutateCache(`/api/factory/tasks?issueId=${encodeURIComponent(task.issueId)}`).catch(() => {})])
      retrying.current = false; setBusy(false)
    }
  }

  /** 验收并合并 (#528): the server merges the PR as this person, bound to the candidate commit. */
  async function accept() {
    if (!ledger || !reportCurrent || deciding.current) return
    deciding.current = true
    setBusy(true); setError(null); setRefused(null)
    try {
      await request(`/api/factory/tasks/${task.id}/approval`, { operation: 'accept', input: { binding: ledger.binding, eventId: crypto.randomUUID() } })
    } catch (caught) {
      const code = caught instanceof RequestError ? caught.code : 'factoryUnavailable'
      if (MERGE_REFUSALS.has(code)) setRefused(code)
      else setError(code)
    } finally {
      // The candidate card's PR reads merged once the merge lands.
      await reloadDecision()
      deciding.current = false
      setBusy(false)
    }
  }

  /** A skill candidate has no PR: it is still enabled through the approval. */
  async function approve() {
    const approvedCandidate = evidence?.manifest?.candidate
    if (!task.isSkillCandidate || !evidence || !approvedCandidate || !environment || deciding.current) return
    const binding = evidence.binding
    const submission = activation?.revision === binding.revision && activation.candidateId === binding.candidateId ? activation
      : { revision: binding.revision, candidateId: binding.candidateId, eventId: crypto.randomUUID() }
    setActivation(submission)
    // Approval reserves and activates the skill atomically. Read the durable ledger after the response.
    await run('approve', {
      binding, eventId: submission.eventId, candidate: approvedCandidate,
      action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: environment,
    })
  }

  async function reconcile() {
    if (!publication) return
    await run('reconcile', { ...publication.request, publicationId: publication.id })
  }

  async function revoke() {
    if (!active || !ledger) return
    await run('revoke', { binding: ledger.binding, approvalId: active.id, eventId: crypto.randomUUID() })
  }

  async function sendBack() {
    if (!ledger?.binding.candidateId || !reportCurrent || deciding.current || reject.phase === 'submitting') return
    deciding.current = true
    dispatchReject({ type: 'submit' })
    try {
      await request(`/api/factory/tasks/${task.id}/approval`, { operation: 'reject', input: { binding: ledger.binding, eventId: crypto.randomUUID(), candidateId: ledger.binding.candidateId, note: reject.note.trim() } })
      dispatchReject({ type: 'succeed' })
    } catch { dispatchReject({ type: 'fail' }) }
    finally { await reloadDecision(); deciding.current = false }
  }

  /** P2: the note typed in the thread's composer, sent as the existing send-back; the fix run follows on the same PR. */
  async function requestChanges(note: string) {
    if (!ledger?.binding.candidateId || !reportCurrent || deciding.current || !note.trim()) return false
    deciding.current = true
    try {
      await request(`/api/factory/tasks/${task.id}/approval`, { operation: 'reject', input: { binding: ledger.binding, eventId: crypto.randomUUID(), candidateId: ledger.binding.candidateId, note: note.trim() } })
      return true
    } catch { return false }
    finally { await reloadDecision(); deciding.current = false }
  }
  const requestChangesRef = useRef(requestChanges)
  requestChangesRef.current = requestChanges
  const register = artifact?.registerReject
  useEffect(() => {
    if (!register) return
    register(note => requestChangesRef.current(note))
    return () => register(null)
  }, [register])

  const readText = useCallback(async (name: string) => {
    const value = await request(`/api/factory/tasks/${task.id}/approval?artifact=${encodeURIComponent(name)}`)
    return typeof value.raw === 'string' ? value.raw : JSON.stringify(value.raw, null, 2)
  }, [task.id])
  const groups = criterionGroups(orderEvidence(evidenceEntries(evidence?.manifest)), checks, task.candidateId)
  const criteria = groups.filter(group => group.title !== null)
  const results = resultRows(checks, task.candidateId)
  const envChip = task.isSkillCandidate ? t('internalSkill') : environment ? t(`envChip.${environment}`) : null
  const open = viewing ? groups[viewing.group] : undefined

  if (ledgerError || evidenceError || detailError || (v2 && flowError)) return <FieldError className="px-6 py-6 text-xs">{t('loadError')}</FieldError>
  if (!detailLoaded || !ledger || (v2 && !flow) || ((v2 ? needsEvidence : task.stage === 'approval' || superseded) && !evidence && !evidenceMissing)) return <div className="flex flex-1 items-center justify-center py-10"><Spinner /></div>
  if (!reportCurrent) return null
  if (artifactBinding && artifact) {
    const kind = artifactReviewKind({ hasArtifact: true, runSucceeded: true, flow: v2 ? flow : null, merge: derived })
    const canRequest = canReject(state, ledger?.capabilities?.reject === true)
    const number = pullNumberOf(pullRequestUrl)
    const time = (iso: string | null | undefined) => iso ? format.dateTime(new Date(iso), { hour: '2-digit', minute: '2-digit' }) : ''
    const unverified = flow?.acceptance?.counts.unverified ?? 0
    const unverifiedNames = criteria.filter(group => group.passed === null).map(group => group.title).filter(Boolean).join('、')
    const merged = ledger.merges?.filter(merge => merge.status === 'merged').at(-1)
    const ask = () => artifact.onRequestChanges(number ? tReview('changeRequestChip', { number }) : tReview('changeRequestLabel'))
    const failedChecks = results.filter(row => row.status === 'failed')
    const actions = <>
      {(kind === 'review' || kind === 'refused' || kind === 'merging') && canRequest && <Button size="sm" variant="secondary" disabled={busy || kind === 'merging'} onClick={ask}>{tReview('changeRequestLabel')}</Button>}
      {(kind === 'review' || kind === 'refused') && <Button size="sm" disabled={busy || kind !== 'review' || !ledger} onClick={() => setConfirming(true)}>{tReview('approveAndMerge')}</Button>}
      {kind === 'merging' && <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Spinner />{tReview('state.merging')}</span>}
      {kind === 'merged' && <>
        <span className="flex items-center gap-1.5 text-sm"><span className="flex size-4 [&_svg]:size-4"><PullRequestIcon state="merged" /></span>{merged?.finishedAt ? tReview('mergedAt', { time: time(merged.finishedAt) }) : tReview('state.merged')}</span>
        {pullRequestUrl && <Button size="sm" variant="ghost" nativeButton={false} render={<a href={pullRequestUrl} target="_blank" rel="noopener noreferrer" />}>{t('openOnGitHub')}</Button>}
      </>}
      {confirming && kind === 'review' && <div className="absolute top-full right-4 z-20 mt-1 w-[min(30rem,calc(100%-2rem))]">
        <ApprovalBar state={state} isSkill={false} busy={busy} canApprove={Boolean(evidence && pullRequestUrl)} onAccept={() => { void accept().finally(() => setConfirming(false)) }}
          confirm={{ warn: unverified > 0, title: unverified > 0 ? (unverifiedNames ? tReview('confirmUnverified', { count: unverified, names: unverifiedNames }) : tReview('confirmUnverifiedCount', { count: unverified })) : tReview('confirmTitle'),
            detail: detail?.delivery?.mergeAs ? tReview('mergeAs', { login: detail.delivery.mergeAs, base: detail.delivery.branch?.base ?? 'main' }) : tReview('mergeTo', { base: detail?.delivery?.branch?.base ?? 'main' }),
            onCancel: () => setConfirming(false) }} />
      </div>}
    </>
    // The report lead (drawn whether or not this decision is bound) states the problem; these are its actions.
    const bannerActions = kind === 'refused' && refusal ? <>
        {canRequest && <Button size="sm" variant="secondary" onClick={ask}>{tReview('letAgentFix')}</Button>}
        <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => { void accept() }}>{busy ? <Spinner data-icon="inline-start" /> : null}{t('retry')}</Button>
      </>
      : (kind === 'blocked' || failedChecks.length > 0) && (retryCheck || recheck) ? <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => { void retryCandidateCheck(!retryCheck) }}>{busy ? <Spinner data-icon="inline-start" /> : null}{tReview('rerunChecks')}</Button>
      : null
    return <>
      {artifact.slots.actions && createPortal(actions, artifact.slots.actions)}
      {artifact.slots.banner && bannerActions && createPortal(bannerActions, artifact.slots.banner)}
      {error && <FieldError className="px-4 pb-2 text-xs">{t(ERROR_KEYS[error] ?? 'error')}</FieldError>}
    </>
  }
  return <div className={cn(artifactBinding ? 'shrink-0' : 'flex min-h-0 flex-1 flex-col')}>
    {!artifactBinding && <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-3 pb-4 sm:px-6">
      <CandidateCard candidate={candidate} detail={detail} environment={envChip} isSkill={task.isSkillCandidate} />
      {evidence && <section aria-label={criteria.length ? t('criteria') : t('evidence')} className="flex flex-col gap-1">
        <h4 className="flex gap-1.5 pl-3 text-xs">
          <span className="font-medium text-muted-foreground">{criteria.length ? t('criteria') : t('evidence')}</span>
          {criteria.length > 0 && <span className="text-muted-foreground/70">{criteria.filter(group => group.passed).length}/{criteria.length}</span>}
        </h4>
        {groups.length
          ? <ul className="flex flex-col gap-1">{groups.map((group, position) => <CriterionRow key={group.key} taskId={task.id} group={group} onOpen={index => setViewing({ group: position, index })} />)}</ul>
          : <p className="pl-3 text-xs text-muted-foreground">{t('evidenceEmpty')}</p>}
      </section>}
      {results.length > 0 && <section aria-label={t('results')} className="flex flex-col gap-1">
        <h4 className="pl-3 text-xs font-medium text-muted-foreground">{t('results')}</h4>
        <ul className="flex flex-col gap-1">{results.map(row => <ResultLine key={row.stage} row={row} onOpenThread={onOpenThread} />)}</ul>
      </section>}
      {check?.status === 'blocked' && currentTask.reason && <RunErrorDetails code={currentTask.reason} />}
      {!check && state === 'failed' && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertTitle>{t('publishFailed')}</AlertTitle></Alert></div>}
      {error && <FieldError className="text-xs">{t(ERROR_KEYS[error] ?? 'error')}</FieldError>}
      {checkError && [retryCheck?.key, recheck?.key].includes(checkError.key) && <FieldError className="text-xs">{t(checkError.unknown ? 'checkRetryUnknown' : 'checkRetryFailed')}</FieldError>}
    </div>}
    {artifactBinding && error && <FieldError className="px-4 pb-2 text-xs">{t(ERROR_KEYS[error] ?? 'error')}</FieldError>}
    {!artifactBinding && detail?.completionRecovery && <footer className="shrink-0 px-4 pb-4 sm:px-5">
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => { void retryCompletion() }}>{busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}{t('retry')}</Button>
    </footer>}
    {!artifactBinding && retryCheck && <footer className="shrink-0 px-4 pb-4 sm:px-5">
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => { void retryCandidateCheck() }}>{busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}{t(retryCheck.stage === 'review' ? 'retryReview' : 'retryVerify')}</Button>
    </footer>}
    {!artifactBinding && recheck && <footer className="flex shrink-0 flex-col items-start gap-2 px-4 pb-4 sm:px-5">
      <p className="text-xs text-muted-foreground">{t('recheckDescription')}</p>
      <Button size="sm" variant="outline" disabled={busy} aria-busy={busy} onClick={() => { void retryCandidateCheck(true) }}>{busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}{t('retryReview')}</Button>
    </footer>}
    {(v2 && flow || !detail?.completionRecovery && !check && state !== 'unavailable') && <footer className="shrink-0 px-4 pb-4 sm:px-5">
      <ApprovalBar state={state} flow={v2 ? flow ?? undefined : undefined} isSkill={task.isSkillCandidate} isDeliverable={candidate?.kind === 'report' || candidate?.kind === 'deliverable'} busy={busy} canApprove={task.isSkillCandidate ? Boolean(evidence && environment) : Boolean(evidence && (pullRequestUrl || candidate?.kind === 'report' || candidate?.kind === 'deliverable'))}
        onAccept={task.isSkillCandidate ? undefined : () => { void accept() }} pullRequestUrl={pullRequestUrl ?? undefined} refusal={refusal ?? undefined} canPublish={Boolean(active && environmentOf(active.candidate) && active.target && active.targetEnvironment)}
        environment={envChip ?? undefined}
        superseded={superseded?.candidate?.sha ?? undefined}
        reference={reference ? { href: reference, label: publication?.request?.targetEnvironment === 'production' ? t('production') : t('preview') } : undefined}
        onApprove={() => { void approve() }}
        onPublish={() => { const approval = active; if (!approval || !ledger) return; void run('publish', { binding: ledger.binding, eventId: crypto.randomUUID(), approvalId: approval.id, action: approval.action, target: approval.target, targetEnvironment: approval.targetEnvironment }) }}
        onRevoke={() => { void revoke() }}
        onReject={canReject(state, ledger?.capabilities?.reject === true) ? () => dispatchReject({ type: 'open' }) : undefined}
        onReconcile={() => { void reconcile() }} />
    </footer>}
    <RejectNote flow={reject} onEdit={note => dispatchReject({ type: 'edit', note })} onSubmit={() => { void sendBack() }} onCancel={() => dispatchReject({ type: 'cancel' })} />
    {viewing && open && open.items[viewing.index] && <EvidenceViewer taskId={task.id} items={open.items} index={viewing.index} title={open.title} passed={open.passed}
      onIndex={index => setViewing({ group: viewing.group, index })} onClose={() => setViewing(null)}
      readText={readText} sha={candidate?.sha ?? undefined} environment={envChip} />}
  </div>
}

/** What the Artifact window hands the pane: where to draw, and the thread composer's 要求修改. */
export type ArtifactReviewSlots = {
  artifactId: string
  slots: ArtifactDecisionSlots
  /** Puts 要求修改 in the thread's composer, as a chip with this label (P2). */
  onRequestChanges: (label: string) => void
  /** The pane hands the window its send-back, so the composer can send the note with it. */
  registerReject: (send: ((note: string) => Promise<boolean>) | null) => void
}
