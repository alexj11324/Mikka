'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronRight, ClipboardCheck, FileText, Image as ImageIcon, Play, RefreshCw, X } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import { MIKKA_VERCEL, publicationActionFor, vercelTarget, type PublicationEnvironment } from '@/lib/factory/vercel-target'
import { acceptanceState, acceptanceStateKey, type AcceptanceState } from '@/lib/factory/acceptance-state'
import { canReject, closedReject, rejectFlow } from '@/lib/factory/reject-flow'
import { ApprovalBar } from './factory-approval-bar'
import { RejectNote } from './factory-reject-note'
import { ShortSha } from './short-sha'
import { IssueThreadPanel } from './issue-thread-panel'

type Candidate = { sha: string; repository: string; environment: string; scope: string }
type Artifact = { artifact: string; kind: 'log' | 'report' | 'screenshot' | 'video' | 'request'; stage: 'execute' | 'review' | 'verify'; runId: string }
type FactoryTask = { id: string; issueId: string; stage: string; status: string; reason: string; candidateId: string | null; candidateRunId: string | null; isSkillCandidate: boolean }
type Evidence = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; evidenceDigest: string; evidenceReadId: string; manifest: { candidate: Candidate; artifacts: Artifact[] } }
type Approval = { id: string; candidateId: string; candidate: Candidate; action: string; target: string; targetEnvironment: string; expiresAt: string; revokedAt: string | null; createdAt: string }
type Publication = { id: string; approvalId: string; status: 'reserved' | 'uncertain' | 'succeeded' | 'failed'; request: Record<string, unknown>; receipt?: { verifiedTarget?: { reference?: string } } }
type Ledger = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; approvals: Approval[]; publications: Publication[]; capabilities?: { reject?: boolean } }

class RequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) { super(code) }
}

async function request(path: string, body?: unknown) {
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

const tone = (state: AcceptanceState) => state === 'live' ? 'success' : state === 'pending' ? 'warning' : state === 'failed' ? 'destructive' : state === 'revoked' || state === 'expired' || state === 'invalidated' ? 'neutral' : 'info'

/** List and window read the same ledger and the same state machine, so they always agree. */
function useAcceptance(task: FactoryTask) {
  const { data: ledger, mutate: reload, error: ledgerError } = useSWR<Ledger>(`/api/factory/tasks/${task.id}/approval?view=ledger`, request, { refreshInterval: 5000 })
  const derived = ledger ? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals: ledger.approvals, publications: ledger.publications, now: Date.now() }) : undefined
  return { ledger, reload, ledgerError, derived }
}

/** The list's load failure. Retry is busy while refetching and cannot fire twice. */
export function FactoryListError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <Alert>
    <AlertTitle>{t('listError')}</AlertTitle>
    <AlertAction><Button size="sm" disabled={retrying} aria-busy={retrying} onClick={onRetry}>{retrying ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}{t('retry')}</Button></AlertAction>
  </Alert>
}

function FactoryAcceptanceRow({ task, onOpen }: { task: FactoryTask; onOpen: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  const state = useAcceptance(task).derived?.state
  return <div className="w-full max-w-[26.25rem]">
    <Item variant="muted">
      <ItemMedia variant="icon"><ClipboardCheck aria-hidden="true" /></ItemMedia>
      <ItemContent>
        <ItemTitle>{task.isSkillCandidate ? t('skillTitle') : t('title')}</ItemTitle>
        <ItemDescription>{task.reason}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {state && <Badge variant="outline" tone={tone(state)}>{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>}
        <Button variant="ghost" size="icon" aria-label={task.isSkillCandidate ? t('skillTitle') : t('title')} onClick={onOpen}><ChevronRight data-icon="inline-start" /></Button>
      </ItemActions>
    </Item>
  </div>
}

/** Acceptance for a Factory task (R-56): evidence on the left, the thread that
 * produced the candidate on the right, and the publication decision on top. */
export function FactoryAcceptance({ issueId, identifier }: { issueId: string; identifier?: string | null }) {
  const t = useTranslations('FactoryAcceptance')
  const { data, error, isLoading, mutate } = useSWR<{ tasks: FactoryTask[] }>(`/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`, request, { refreshInterval: 15000 })
  const [open, setOpen] = useState<FactoryTask | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retryingRef = useRef(false)
  const focusAfterRetry = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const tasks = data?.tasks.filter(task => (task.stage === 'approval' && ['pending', 'waiting'].includes(task.status)) || task.stage === 'publish') ?? []
  const failed = Boolean(error && !data)
  useEffect(() => {
    if (!focusAfterRetry.current || failed || isLoading) return
    focusAfterRetry.current = false
    headingRef.current?.focus()
  }, [failed, isLoading, data])
  async function retry() {
    if (retryingRef.current) return
    retryingRef.current = true; setRetrying(true)
    // Armed before the refetch: SWR can render the new data before mutate() resolves.
    focusAfterRetry.current = true
    try { if (!await mutate()) focusAfterRetry.current = false } catch { focusAfterRetry.current = false /* the alert stays */ }
    finally { retryingRef.current = false; setRetrying(false) }
  }
  const heading = <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">{t('title')}</h3>
  if (failed) return <section className="flex flex-col gap-2">
    {heading}
    <div className="min-h-16 w-full max-w-[26.25rem]"><FactoryListError retrying={retrying} onRetry={() => { void retry() }} /></div>
  </section>
  if (isLoading) return <section aria-busy="true" className="flex flex-col gap-2">
    {heading}
    <div className="h-16 w-full max-w-[26.25rem] overflow-hidden rounded-xl"><Skeleton data-testid="factory-acceptance-loading" className="size-full" /></div>
  </section>
  if (!tasks.length) return null
  return <section className="flex flex-col gap-2">
    {heading}
    {tasks.map(task => <FactoryAcceptanceRow key={task.id} task={task} onOpen={() => setOpen(task)} />)}
    {open && <FactoryAcceptanceWindow task={open} identifier={identifier} onClose={() => setOpen(null)} />}
  </section>
}

function FactoryAcceptanceWindow({ task, identifier, onClose }: { task: FactoryTask; identifier?: string | null; onClose: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const { ledger, reload, ledgerError, derived: acceptance } = useAcceptance(task)
  // A voided approval puts the task back to pending, so the current candidate's evidence is needed to enable it again.
  const { data: evidence, error: evidenceError } = useSWR<Evidence>(task.stage === 'approval' || acceptance?.superseded ? `/api/factory/tasks/${task.id}/approval` : null, request)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<{ name: string; content: string } | null>(null)
  const [artifactError, setArtifactError] = useState(false)
  const [reject, dispatchReject] = useReducer(rejectFlow, closedReject)

  const approvals = ledger?.approvals ?? []
  const latest = approvals[approvals.length - 1]
  const derived = acceptance ?? acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals, publications: [], now: Date.now() })
  const state = derived.state
  const active = derived.active as Approval | undefined
  const publication = derived.publication as Publication | undefined
  const superseded = derived.superseded as Approval | undefined
  // Only an approval on the current candidate may describe it; a voided one carries the old sha.
  const current = latest && latest.candidateId === task.candidateId ? latest : undefined
  const candidate = evidence?.manifest.candidate ?? active?.candidate ?? current?.candidate
  const environment = environmentOf(candidate)
  const reference = publication?.receipt?.verifiedTarget?.reference

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
    if (!evidence || !environment) return
    const action = task.isSkillCandidate ? 'activate_skill' : publicationActionFor(environment)
    const target = task.isSkillCandidate ? 'mikka-builtin:run-report' : vercelTarget({ ...MIKKA_VERCEL, environment })
    const binding = evidence.binding
    const approved = await run('approve', {
      binding, eventId: crypto.randomUUID(), candidate: evidence.manifest.candidate, action, target,
      targetEnvironment: environment, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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

  async function view(name: string) {
    setArtifactError(false)
    try {
      const value = await request(`/api/factory/tasks/${task.id}/approval?artifact=${encodeURIComponent(name)}`)
      setArtifact({ name, content: typeof value.raw === 'string' ? value.raw : JSON.stringify(value.raw, null, 2) })
    } catch { setArtifactError(true) }
  }

  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className="flex max-h-[85svh] flex-col sm:max-w-5xl">
      <header className="flex shrink-0 items-center gap-2">
        <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle>{t(task.isSkillCandidate ? 'skillTitle' : 'title')}</DialogTitle>
        {identifier && <span className="font-mono text-xs text-muted-foreground">{identifier}</span>}
        <Badge variant="outline" tone={tone(state)}>{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>
        {candidate?.sha && <ShortSha sha={candidate.sha} />}
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {(ledgerError || evidenceError) ? <p role="alert" className="px-8 py-6 text-xs text-destructive">{t('loadError')}</p>
            : !ledger || ((task.stage === 'approval' || superseded) && !evidence) ? <div className="flex flex-1 items-center justify-center"><Spinner /></div>
              : <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-8 py-6">
                <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('candidate')}</h4>
                  <Item variant="muted">
                    <ItemContent>
                      {candidate?.sha && <ItemDescription><ShortSha sha={candidate.sha} /></ItemDescription>}
                      <ItemDescription>{candidate?.repository}</ItemDescription>
                      <ItemDescription>{task.isSkillCandidate ? t('internalSkill') : environment ? t(environment) : t('state.unavailable')}</ItemDescription>
                    </ItemContent>
                  </Item>
                </section>
                {task.isSkillCandidate && <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('target')}</h4>
                  <Item variant="muted"><ItemContent><ItemDescription><code>mikka-builtin:run-report</code></ItemDescription></ItemContent></Item>
                </section>}
                {evidence && <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('evidence')}</h4>
                  <div className="flex flex-col gap-1">
                    {evidence.manifest.artifacts.map(item => <Item key={item.artifact} variant="muted" size="sm">
                      <ItemMedia variant="icon">{item.kind === 'screenshot' ? <ImageIcon aria-hidden="true" /> : item.kind === 'video' ? <Play aria-hidden="true" /> : <FileText aria-hidden="true" />}</ItemMedia>
                      <ItemContent><ItemDescription><code>{item.artifact}</code></ItemDescription></ItemContent>
                      <ItemActions>
                        <Badge variant="outline" tone="neutral">{t(`stage.${item.stage}`)}</Badge>
                        <Button variant="ghost" size="icon-sm" aria-label={item.artifact} onClick={() => { void view(item.artifact) }}><ChevronRight data-icon="inline-start" /></Button>
                      </ItemActions>
                    </Item>)}
                  </div>
                  {artifactError && <p role="alert" className="text-xs text-destructive">{t('artifactError')}</p>}
                </section>}
                {state === 'failed' && <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:slide-in-from-bottom-0"><Alert variant="destructive"><AlertTitle>{t('publishFailed')}</AlertTitle></Alert></div>}
                {state !== 'unavailable' && <ApprovalBar state={state} isSkill={task.isSkillCandidate} busy={busy} canApprove={Boolean(evidence && environment)} canPublish={Boolean(active && environmentOf(active.candidate) && active.target && active.targetEnvironment)}
                  details={[
                    ...(task.isSkillCandidate ? [t('internalSkill')] : environment ? [t(environment)] : []),
                    ...(active ? [t('expires', { time: format.dateTime(new Date(active.expiresAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })] : []),
                  ]}
                  sha={candidate?.sha} superseded={superseded?.candidate?.sha}
                  reference={reference ? { href: reference, label: publication?.request.targetEnvironment === 'production' ? t('production') : t('preview') } : undefined}
                  onApprove={() => { void approve() }}
                  onPublish={() => { const approval = active; if (!approval || !ledger) return; void run('publish', { binding: ledger.binding, eventId: crypto.randomUUID(), approvalId: approval.id, action: approval.action, target: approval.target, targetEnvironment: approval.targetEnvironment }) }}
                  onRevoke={() => { void revoke() }}
                  onReject={canReject(state, ledger?.capabilities?.reject === true) ? () => dispatchReject({ type: 'open' }) : undefined}
                  onReconcile={() => { void reconcile() }} />}
                {error && <p role="alert" className="text-xs text-destructive">{t(ERROR_KEYS[error] ?? 'error')}</p>}
              </div>}
        </main>
        {task.candidateRunId && <aside aria-label={t('thread')} className="hidden w-[25rem] shrink-0 flex-col bg-muted/50 md:flex">
          <IssueThreadPanel issueId={task.issueId} runId={task.candidateRunId} onClose={onClose} bare />
        </aside>}
      </div>
      <RejectNote flow={reject} onEdit={note => dispatchReject({ type: 'edit', note })} onSubmit={() => { void sendBack() }} onCancel={() => dispatchReject({ type: 'cancel' })} />
      {artifact && <ArtifactPreview name={artifact.name} content={artifact.content} onClose={() => setArtifact(null)} />}
    </DialogContent>
  </Dialog>
}

function ArtifactPreview({ name, content, onClose }: { name: string; content: string; onClose: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent aria-describedby={undefined} closeLabel={t('closeEvidence')} className="flex max-h-[85svh] flex-col sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle><code>{name}</code></DialogTitle>
      </DialogHeader>
      <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap break-words">{content}</pre>
    </DialogContent>
  </Dialog>
}
