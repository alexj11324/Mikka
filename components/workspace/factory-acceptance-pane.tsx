'use client'

import { useCallback, useReducer, useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { CircleCheck, CircleDashed, CircleX, ExternalLink, GitCommitHorizontal, Server } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { MIKKA_VERCEL, publicationActionFor, vercelTarget, type PublicationEnvironment } from '@/lib/factory/vercel-target'
import { acceptanceState } from '@/lib/factory/acceptance-state'
import { canReject, closedReject, rejectFlow } from '@/lib/factory/reject-flow'
import { evidenceEntries, orderEvidence, type EvidenceEntry } from '@/lib/factory/evidence-view'
import { bareUrl, criterionGroups, pullNumber, resultRows, type AcceptanceDetail, type CriterionGroup, type ResultRow } from '@/lib/factory/acceptance-view'
import { CriterionEvidence, EvidenceViewer } from './factory-evidence'
import { ApprovalBar } from './factory-approval-bar'
import { RejectNote } from './factory-reject-note'
import { PullRequestIcon } from './pull-request-icon'
import { ShortSha, shortSha } from './short-sha'

type Candidate = { sha: string; repository: string; environment: string; scope: string }
export type FactoryTask = { id: string; issueId: string; stage: string; status: string; reason: string; candidateId: string | null; candidateRunId: string | null; isSkillCandidate: boolean }
type Evidence = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; evidenceDigest: string; evidenceReadId: string; manifest: { candidate: Candidate; artifacts: EvidenceEntry[] } }
type Approval = { id: string; candidateId: string; candidate: Candidate; action: string; target: string; targetEnvironment: string; expiresAt: string; revokedAt: string | null; createdAt: string }
type Publication = { id: string; approvalId: string; status: 'reserved' | 'uncertain' | 'succeeded' | 'failed'; request: Record<string, unknown>; receipt?: { verifiedTarget?: { reference?: string } } }
type Ledger = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; approvals: Approval[]; publications: Publication[]; capabilities?: { reject?: boolean } }

export class RequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) { super(code) }
}

export async function request(path: string, body?: unknown) {
  const response = await fetch(withBasePath(path), body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (response.status === 202) return { ...value, deferred: true }
  if (!response.ok) throw new RequestError(value.error ?? 'factoryUnavailable', response.status, value)
  return value
}

const environmentOf = (candidate: Candidate | undefined): PublicationEnvironment | null =>
  candidate?.environment === 'production' ? 'production' : candidate?.environment === 'preview' ? 'preview' : null

type ErrorKey = 'error' | 'decisionUnavailable' | 'publicationUnavailable' | 'attestationRequired'
const ERROR_KEYS: Record<string, ErrorKey> = {
  factoryPolicyDecisionUnavailable: 'decisionUnavailable',
  factoryPublicationUnavailable: 'publicationUnavailable',
  factoryPolicyAttestationRequired: 'attestationRequired',
}

/** The approval the client asks for lasts one hour (the bar says so). */
const APPROVAL_HOURS = 1

/** List, header and pane read the same ledger and the same state machine, so they always agree. */
export function useAcceptance(task: FactoryTask) {
  const { data: ledger, mutate: reload, error: ledgerError } = useSWR<Ledger>(`/api/factory/tasks/${task.id}/approval?view=ledger`, request, { refreshInterval: 5000 })
  const derived = ledger ? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals: Array.isArray(ledger.approvals) ? ledger.approvals : [], publications: Array.isArray(ledger.publications) ? ledger.publications : [], now: Date.now() }) : undefined
  return { ledger, reload, ledgerError, derived }
}

function Label({ children }: { children: string }) {
  return <span className="w-14 shrink-0 text-xs text-muted-foreground">{children}</span>
}

/** Frame 06 「候选」: the PR, the commit, the preview and where it runs. */
function CandidateCard({ candidate, detail, environment, isSkill }: { candidate?: Candidate; detail?: AcceptanceDetail; environment: string | null; isSkill: boolean }) {
  const t = useTranslations('FactoryAcceptance')
  const delivery = detail?.delivery
  const pr = delivery?.pullRequest
  const number = pr ? pullNumber(pr.url) : null
  const sha = candidate?.sha ?? delivery?.candidateSha ?? undefined
  const repository = candidate?.repository ?? delivery?.repository
  const branch = delivery?.databaseBranch
  return <section aria-label={t('candidate')} className="flex flex-col gap-2 rounded-xl bg-muted px-4 py-3.5">
    {pr && <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="flex size-4 shrink-0 [&_svg]:size-4"><PullRequestIcon state={pr.state} /></span>
      <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0 font-medium hover:underline">{number ? `#${number}` : t('pullRequest')}</a>
      {repository && <span className="min-w-0 truncate text-muted-foreground">{repository}</span>}
    </div>}
    {sha && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('commitLabel')}</Label>
      <GitCommitHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <ShortSha sha={sha} />
      {!pr && repository && <span className="min-w-0 truncate text-xs text-muted-foreground">{repository}</span>}
    </div>}
    {delivery?.previewUrl && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('previewLabel')}</Label>
      <a href={delivery.previewUrl} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 text-sm hover:underline">
        <span className="truncate">{bareUrl(delivery.previewUrl)}</span><ExternalLink aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </a>
    </div>}
    <div className="flex min-w-0 items-center gap-2">
      <Label>{t('environmentLabel')}</Label>
      <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm">{isSkill ? t('internalSkill') : environment ?? t('state.unavailable')}{branch ? ` · Neon ${branch.name}` : ''}</span>
    </div>
    {isSkill && <div className="flex min-w-0 items-center gap-2">
      <Label>{t('target')}</Label>
      <code className="truncate text-xs">mikka-builtin:run-report</code>
    </div>}
  </section>
}

function Verdict({ passed }: { passed: boolean | null }) {
  if (passed === null) return <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
  return passed ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" /> : <CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive" />
}

/** Figma `Factory/CriterionRow`: the criterion, its result, and the evidence that shows it. */
function CriterionRow({ taskId, group, onOpen }: { taskId: string; group: CriterionGroup; onOpen: (index: number) => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <li className="flex flex-col gap-2 rounded-xl px-3 pt-2.5 pb-3">
    <div className="flex min-w-0 items-center gap-2">
      {group.title !== null && <Verdict passed={group.passed} />}
      <h5 className={cn('min-w-0 flex-1 text-sm', group.title === null ? 'text-xs text-muted-foreground' : 'font-medium')}>{group.title ?? t('otherEvidence')}</h5>
      {group.title !== null && group.passed !== null && <span className={cn('shrink-0 text-xs', group.passed ? 'text-success' : 'text-destructive')}>{t(group.passed ? 'passed' : 'notPassed')}</span>}
    </div>
    {group.items.length > 0 && <div className={cn(group.title !== null && 'pl-6')}><CriterionEvidence taskId={taskId} items={group.items} onOpen={onOpen} /></div>}
  </li>
}

const RESULT_WORD = { review: { passed: 'reviewPassed', failed: 'reviewFailed' }, verify: { passed: 'passed', failed: 'notPassed' } } as const

/** Figma `Factory/ResultRow`: the independent review or verify, its verdict and its thread. */
function ResultLine({ row, onOpenThread }: { row: ResultRow; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const done = row.status === 'passed' || row.status === 'failed'
  const word = row.status === 'passed' || row.status === 'failed' ? t(RESULT_WORD[row.stage][row.status]) : t('inProgress')
  const meta = row.stage === 'verify' ? (row.total ? `${row.passed}/${row.total}` : null) : row.total - row.passed > 0 ? t('opinions', { count: String(row.total - row.passed) }) : null
  const thread = t(row.stage === 'review' ? 'reviewThread' : 'verifyThread')
  return <li className="flex min-h-10 min-w-0 flex-wrap items-center gap-2 rounded-xl px-3 py-2.5">
    {done ? <Verdict passed={row.status === 'passed'} /> : <Spinner className="size-4 shrink-0 text-muted-foreground" />}
    <span className="text-sm font-medium">{t(row.stage === 'review' ? 'review' : 'verify')}</span>
    <span className={cn('text-sm', row.status === 'passed' ? 'text-success' : row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{word}</span>
    {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
    <span className="flex-1" />
    {row.runId && onOpenThread
      ? <Button variant="secondary" size="xs" onClick={() => onOpenThread(row.runId!)}><Verdict passed={done ? row.status === 'passed' : null} />{thread}</Button>
      : <span className="text-xs text-muted-foreground">{thread}</span>}
    {row.sha && <span className="font-mono text-xs text-muted-foreground">{shortSha(row.sha)}</span>}
  </li>
}

/**
 * The 验收 tab (Figma 357:4750, frame 06; phone 365:12779): the candidate,
 * each acceptance criterion with its evidence, the independent results, and
 * the decision bar pinned to the bottom. Approve, publish, reconcile, revoke
 * and send-back are the A1/A2 operations on the approval route.
 */
export function FactoryAcceptancePane({ task, onOpenThread }: { task: FactoryTask; onOpenThread?: (runId: string) => void }) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const { ledger, reload, ledgerError, derived: acceptance } = useAcceptance(task)
  // A voided approval puts the task back to pending, so the current candidate's evidence is needed to enable it again.
  const { data: evidence, error: evidenceError } = useSWR<Evidence>(task.stage === 'approval' || acceptance?.superseded ? `/api/factory/tasks/${task.id}/approval` : null, request)
  // Checks and the delivery header (B8/B9/B11) are read-only extras; the pane works without them.
  const { data: detail } = useSWR<AcceptanceDetail>(`/api/factory/tasks/${task.id}`, request)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ group: number; index: number } | null>(null)
  const [reject, dispatchReject] = useReducer(rejectFlow, closedReject)

  const approvals = ledger && Array.isArray(ledger.approvals) ? ledger.approvals : []
  const latest = approvals[approvals.length - 1]
  const derived = acceptance ?? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals, publications: [], now: Date.now() })
  const state = derived.state
  const active = derived.active as Approval | undefined
  const publication = derived.publication as Publication | undefined
  const superseded = derived.superseded as Approval | undefined
  // Only an approval on the current candidate may describe it; a voided one carries the old sha.
  const current = latest && latest.candidateId === task.candidateId ? latest : undefined
  const candidate = evidence?.manifest?.candidate ?? active?.candidate ?? current?.candidate
  const environment = environmentOf(candidate)
  const reference = publication?.receipt?.verifiedTarget?.reference
  const checks = Array.isArray(detail?.checks) ? detail.checks : []

  async function run(operation: 'approve' | 'publish' | 'reconcile' | 'revoke', input: Record<string, unknown>) {
    setBusy(true); setError(null)
    try {
      const result = await request(`/api/factory/tasks/${task.id}/approval`, { operation, input })
      await reload()
      return result
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.code : 'factoryUnavailable')
      await reload().catch(() => {})
      return null
    } finally { setBusy(false) }
  }

  async function approve() {
    const approvedCandidate = evidence?.manifest?.candidate
    if (!evidence || !approvedCandidate || !environment) return
    const action = task.isSkillCandidate ? 'activate_skill' : publicationActionFor(environment)
    const target = task.isSkillCandidate ? 'mikka-builtin:run-report' : vercelTarget({ ...MIKKA_VERCEL, environment })
    const binding = evidence.binding
    const approved = await run('approve', {
      binding, eventId: crypto.randomUUID(), candidate: approvedCandidate, action, target,
      targetEnvironment: environment, expiresAt: new Date(Date.now() + APPROVAL_HOURS * 60 * 60 * 1000).toISOString(),
      evidenceDigest: evidence.evidenceDigest, evidenceReadId: evidence.evidenceReadId,
    })
    if (!approved?.approvalId) return
    // The approval advances the task; publish must carry the returned binding.
    await run('publish', { binding: approved.binding ?? binding, eventId: crypto.randomUUID(), approvalId: approved.approvalId, action, target, targetEnvironment: environment })
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
    if (!ledger || reject.phase === 'submitting') return
    dispatchReject({ type: 'submit' })
    try {
      await request(`/api/factory/tasks/${task.id}/approval`, { operation: 'reject', input: { binding: ledger.binding, eventId: crypto.randomUUID(), note: reject.note.trim() } })
      dispatchReject({ type: 'succeed' })
      await reload()
    } catch { dispatchReject({ type: 'fail' }) }
  }

  const readText = useCallback(async (name: string) => {
    const value = await request(`/api/factory/tasks/${task.id}/approval?artifact=${encodeURIComponent(name)}`)
    return typeof value.raw === 'string' ? value.raw : JSON.stringify(value.raw, null, 2)
  }, [task.id])
  const groups = criterionGroups(orderEvidence(evidenceEntries(evidence?.manifest)), checks, task.candidateId)
  const criteria = groups.filter(group => group.title !== null)
  const results = resultRows(checks, task.candidateId)
  const envChip = task.isSkillCandidate ? t('internalSkill') : environment ? t(`envChip.${environment}`) : null
  const open = viewing ? groups[viewing.group] : undefined

  if (ledgerError || evidenceError) return <p role="alert" className="px-6 py-6 text-xs text-destructive">{t('loadError')}</p>
  if (!ledger || ((task.stage === 'approval' || superseded) && !evidence)) return <div className="flex flex-1 items-center justify-center py-10"><Spinner /></div>
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-3 pb-4 sm:px-6">
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
      {state === 'failed' && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertTitle>{t('publishFailed')}</AlertTitle></Alert></div>}
      {error && <p role="alert" className="text-xs text-destructive">{t(ERROR_KEYS[error] ?? 'error')}</p>}
    </div>
    {state !== 'unavailable' && <footer className="shrink-0 px-4 pb-4 sm:px-5">
      <ApprovalBar state={state} isSkill={task.isSkillCandidate} busy={busy} canApprove={Boolean(evidence && environment)} canPublish={Boolean(active && environmentOf(active.candidate) && active.target && active.targetEnvironment)}
        environment={envChip ?? undefined}
        details={active ? [t('expires', { time: format.dateTime(new Date(active.expiresAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })] : state === 'pending' ? [t('validFor', { hours: String(APPROVAL_HOURS) })] : []}
        sha={candidate?.sha} superseded={superseded?.candidate?.sha}
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
      readText={readText} sha={candidate?.sha} environment={envChip} />}
  </div>
}
