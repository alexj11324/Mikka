'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronRight, ClipboardCheck, FileText, Image as ImageIcon, LoaderCircle, Play, X } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { withBasePath } from '@/lib/base-path'
import { MIKKA_VERCEL, publicationActionFor, vercelTarget, type PublicationEnvironment } from '@/lib/factory/vercel-target'
import { acceptanceState, acceptanceStateKey, type AcceptanceState } from '@/lib/factory/acceptance-state'
import { ApprovalBar } from './factory-approval-bar'
import { IssueThreadPanel } from './issue-thread-panel'

type Candidate = { sha: string; repository: string; environment: string; scope: string }
type Artifact = { artifact: string; kind: 'log' | 'report' | 'screenshot' | 'video' | 'request'; stage: 'execute' | 'review' | 'verify'; runId: string }
type FactoryTask = { id: string; issueId: string; stage: string; status: string; reason: string; candidateId: string | null; candidateRunId: string | null; isSkillCandidate: boolean }
type Evidence = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; evidenceDigest: string; evidenceReadId: string; manifest: { candidate: Candidate; artifacts: Artifact[] } }
type Approval = { id: string; candidateId: string; candidate: Candidate; action: string; target: string; targetEnvironment: string; expiresAt: string; revokedAt: string | null }
type Publication = { id: string; approvalId: string; status: 'reserved' | 'uncertain' | 'succeeded' | 'failed'; request: Record<string, unknown>; receipt?: { verifiedTarget?: { reference?: string } } }
type Ledger = { binding: { taskId: string; issueId: string; attemptId: string; revision: number; candidateId: string | null }; approvals: Approval[]; publications: Publication[] }

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

const taskState = (task: FactoryTask): AcceptanceState => task.stage === 'approval'
  ? 'pending'
  : task.status === 'failed' ? 'checking' : task.status === 'passed' ? 'live' : task.status === 'running' || task.status === 'waiting' ? 'publishing' : 'approved'

const tone = (state: AcceptanceState) => state === 'live' ? 'success' : state === 'pending' ? 'warning' : state === 'failed' ? 'destructive' : state === 'revoked' || state === 'expired' || state === 'invalidated' ? 'neutral' : 'info'

/** Acceptance for a Factory task (R-56): evidence on the left, the thread that
 * produced the candidate on the right, and the publication decision on top. */
export function FactoryAcceptance({ issueId, identifier }: { issueId: string; identifier?: string | null }) {
  const t = useTranslations('FactoryAcceptance')
  const { data, error, isLoading, mutate } = useSWR<{ tasks: FactoryTask[] }>(`/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`, request, { refreshInterval: 15000 })
  const [open, setOpen] = useState<FactoryTask | null>(null)
  const tasks = data?.tasks.filter(task => (task.stage === 'approval' && ['pending', 'waiting'].includes(task.status)) || task.stage === 'publish') ?? []
  if (error && !data) return <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{t('title')}</h3>
    <Alert className="max-w-[26.25rem]">
      <AlertTitle>{t('listError')}</AlertTitle>
      <AlertAction><Button size="sm" variant="outline" onClick={() => { void mutate() }}>{t('retry')}</Button></AlertAction>
    </Alert>
  </section>
  if (isLoading) return <section aria-busy="true" className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{t('title')}</h3>
    <Skeleton data-testid="factory-acceptance-loading" className="h-16 w-full max-w-[26.25rem]" />
  </section>
  if (!tasks.length) return null
  return <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{t('title')}</h3>
    {tasks.map(task => {
      const state = taskState(task)
      return <Button key={task.id} variant="ghost" onClick={() => setOpen(task)}
        className="h-16 w-full max-w-[26.25rem] justify-start gap-3 rounded-xl bg-muted/60 px-3 text-left font-normal hover:bg-muted">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background"><ClipboardCheck aria-hidden="true" data-icon="inline-start" className="size-5" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{task.isSkillCandidate ? t('skillTitle') : t('title')}</span>
          <span className="truncate text-xs text-muted-foreground">{task.reason}</span>
        </span>
        <Badge variant="outline" tone={tone(state)}>{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>
        <ChevronRight aria-hidden="true" data-icon="inline-end" className="text-muted-foreground" />
      </Button>
    })}
    {open && <FactoryAcceptanceWindow task={open} identifier={identifier} onClose={() => setOpen(null)} />}
  </section>
}

function FactoryAcceptanceWindow({ task, identifier, onClose }: { task: FactoryTask; identifier?: string | null; onClose: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  const format = useFormatter()
  const { data: ledger, mutate: reload, error: ledgerError } = useSWR<Ledger>(`/api/factory/tasks/${task.id}/approval?view=ledger`, request, { refreshInterval: 5000 })
  const { data: evidence, error: evidenceError } = useSWR<Evidence>(task.stage === 'approval' ? `/api/factory/tasks/${task.id}/approval` : null, request)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<{ name: string; content: string } | null>(null)
  const [artifactError, setArtifactError] = useState(false)

  const approvals = ledger?.approvals ?? []
  const latest = approvals[approvals.length - 1]
  const derived = acceptanceState({ stage: task.stage, candidateId: task.candidateId, approvals, publications: ledger?.publications ?? [], now: Date.now() })
  const state = derived.state
  const active = derived.active as Approval | undefined
  const publication = derived.publication as Publication | undefined
  const candidate = evidence?.manifest.candidate ?? active?.candidate ?? latest?.candidate
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

  async function view(name: string) {
    setArtifactError(false)
    try {
      const value = await request(`/api/factory/tasks/${task.id}/approval?artifact=${encodeURIComponent(name)}`)
      setArtifact({ name, content: typeof value.raw === 'string' ? value.raw : JSON.stringify(value.raw, null, 2) })
    } catch { setArtifactError(true) }
  }

  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className="flex h-[min(53.75rem,calc(100dvh-2rem))] w-[min(80rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-0 sm:max-w-none">
      <header className="flex h-13 shrink-0 items-center gap-2 px-4">
        <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle className="truncate text-sm leading-5 font-medium">{t(task.isSkillCandidate ? 'skillTitle' : 'title')}</DialogTitle>
        {identifier && <span className="font-mono text-xs text-muted-foreground">{identifier}</span>}
        <Badge variant="outline" tone={tone(state)}>{t(acceptanceStateKey(state, task.isSkillCandidate))}</Badge>
        {candidate?.sha && <span className="font-mono text-xs text-muted-foreground">{candidate.sha.slice(0, 7)}</span>}
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background">
          {(ledgerError || evidenceError) ? <p role="alert" className="px-8 py-6 text-xs text-destructive">{t('error')}</p>
            : !ledger || (task.stage === 'approval' && !evidence) ? <div className="flex flex-1 items-center justify-center"><LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" /></div>
              : <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-8 py-6">
                <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('candidate')}</h4>
                  <Item variant="muted">
                    <ItemContent>
                      <ItemTitle className="font-mono">{candidate?.sha}</ItemTitle>
                      <ItemDescription>{candidate?.repository}</ItemDescription>
                      <ItemDescription>{task.isSkillCandidate ? t('internalSkill') : environment ? t(environment) : t('state.unavailable')}</ItemDescription>
                    </ItemContent>
                  </Item>
                </section>
                {task.isSkillCandidate && <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('target')}</h4>
                  <Item variant="muted"><ItemContent><ItemTitle className="font-mono">mikka-builtin:run-report</ItemTitle></ItemContent></Item>
                </section>}
                {evidence && <section className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{t('evidence')}</h4>
                  <div className="flex flex-col gap-1">
                    {evidence.manifest.artifacts.map(item => <Button key={item.artifact} variant="ghost" onClick={() => { void view(item.artifact) }}
                      className="h-auto min-w-0 justify-start gap-3 rounded-xl bg-control px-3 py-2 text-left font-normal hover:bg-control-hover">
                      {item.kind === 'screenshot' ? <ImageIcon aria-hidden="true" data-icon="inline-start" className="text-muted-foreground" />
                        : item.kind === 'video' ? <Play aria-hidden="true" data-icon="inline-start" className="text-muted-foreground" />
                          : <FileText aria-hidden="true" data-icon="inline-start" className="text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.artifact}</span>
                      <Badge variant="outline" tone="neutral">{t(`stage.${item.stage}`)}</Badge>
                      <ChevronRight aria-hidden="true" data-icon="inline-end" className="text-muted-foreground" />
                    </Button>)}
                  </div>
                  {artifactError && <p role="alert" className="text-xs text-destructive">{t('artifactError')}</p>}
                </section>}
                {state !== 'unavailable' && <ApprovalBar state={state} isSkill={task.isSkillCandidate} busy={busy} canApprove={Boolean(evidence && environment)}
                  details={[
                    ...(task.isSkillCandidate ? [t('internalSkill')] : environment ? [t(environment)] : []),
                    ...(candidate?.sha ? [candidate.sha.slice(0, 7)] : []),
                    ...(active ? [t('expires', { time: format.dateTime(new Date(active.expiresAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })] : []),
                  ]}
                  reference={reference ? { href: reference, label: publication?.request.targetEnvironment === 'production' ? t('production') : t('preview') } : undefined}
                  onApprove={() => { void approve() }}
                  onPublish={() => { const approval = active; if (!approval || !ledger) return; void run('publish', { binding: ledger.binding, eventId: crypto.randomUUID(), approvalId: approval.id, action: approval.action, target: approval.target, targetEnvironment: approval.targetEnvironment }) }}
                  onRevoke={() => { void revoke() }}
                  onReconcile={() => { void reconcile() }} />}
                {error && <p role="alert" className="text-xs text-destructive">{t(ERROR_KEYS[error] ?? 'error')}</p>}
              </div>}
        </main>
        {task.candidateRunId && <aside aria-label={t('thread')} className="hidden w-[25rem] shrink-0 flex-col bg-muted/50 md:flex">
          <IssueThreadPanel issueId={task.issueId} runId={task.candidateRunId} onClose={onClose} bare />
        </aside>}
      </div>
      {artifact && <ArtifactPreview name={artifact.name} content={artifact.content} onClose={() => setArtifact(null)} />}
    </DialogContent>
  </Dialog>
}

function ArtifactPreview({ name, content, onClose }: { name: string; content: string; onClose: () => void }) {
  const t = useTranslations('FactoryAcceptance')
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} className="flex max-h-[85svh] w-[min(64rem,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
        <DialogTitle className="min-w-0 flex-1 truncate font-mono text-xs">{name}</DialogTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('closeEvidence')} onClick={onClose}><X data-icon="inline-start" /></Button>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto bg-background px-4 py-3 font-mono text-xs whitespace-pre-wrap break-words">{content}</pre>
    </DialogContent>
  </Dialog>
}
