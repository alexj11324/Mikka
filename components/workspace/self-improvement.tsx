'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { withBasePath } from '@/lib/base-path'
import { currentSkillApproval, hasRecordedSkillActivation } from '@/lib/self-improvement/approval-view'

async function request(path: string, body?: unknown) {
  const response = await fetch(withBasePath(path), body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'request failed') }
  return response.json()
}

export function ThreadFeedback({ runId }: { runId: string }) {
  const t = useTranslations('SelfImprovement')
  const { data, error } = useSWR(`/api/self-improvement?runId=${encodeURIComponent(runId)}`, request, { shouldRetryOnError: false })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'saved' | 'error' | null>(null)
  if (error && ['notFound', 'runUnavailable'].includes(error.message)) return null
  if (error) return <p role="alert" className="text-xs">{t('error')}</p>
  if (!data) return null
  async function submit(verdict: 'positive' | 'negative') {
    setBusy(true); setResult(null)
    try { await request('/api/self-improvement', { action: 'feedback', eventId: crypto.randomUUID(), runId, verdict, note }); setResult('saved') }
    catch { setResult('error') }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2"><p className="text-sm font-medium">{t('feedback')}</p><Textarea aria-label={t('feedbackNote')} placeholder={t('feedbackNote')} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || result === 'saved'} onClick={() => { void submit('positive') }}>{t('positive')}</Button><Button size="sm" variant="outline" disabled={busy || result === 'saved'} onClick={() => { void submit('negative') }}>{t('negative')}</Button></div>{result && <p role={result === 'error' ? 'alert' : 'status'} className="text-xs">{t(result)}</p>}</div>
}

type Evidence = { binding: { taskId: string }; evidenceDigest: string; evidenceReadId: string; manifest: { candidate: unknown; skill?: { markdown: string; evaluation: unknown }; artifacts: { artifact: string; stage: string }[] } }
type FactoryTask = { id: string; stage: string; status: string; isSkillCandidate: boolean }
export function SkillApprovals({ issueId }: { issueId: string }) {
  const t = useTranslations('SelfImprovement')
  const { data, error, mutate } = useSWR<{ tasks: FactoryTask[] }>(`/api/factory/tasks?issueId=${encodeURIComponent(issueId)}`, request)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [artifacts, setArtifacts] = useState<unknown[]>([])
  const [environment, setEnvironment] = useState('')
  const [approval, setApproval] = useState<{ binding: { taskId: string }; approvalId: string; environment: string; publication?: { id: string; request: Record<string, unknown> } } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'error' | 'approved' | 'activated' | null>(null)
  const tasks = data?.tasks.filter(task => task.isSkillCandidate && (task.stage === 'approval' || task.stage === 'publish') && (['pending', 'waiting'].includes(task.status) || (task.stage === 'publish' && task.status === 'passed'))) ?? []
  async function review(taskId: string) {
    setBusy(true); setStatus(null); setEvidence(null); setApproval(null); setArtifacts([]); setEnvironment('')
    try {
      const value: Evidence = await request(`/api/factory/tasks/${taskId}/approval`)
      if (!value.manifest.skill) throw new Error('not a skill candidate')
      const sources = await Promise.all(value.manifest.artifacts.map(item => request(`/api/factory/tasks/${taskId}/approval?artifact=${encodeURIComponent(item.artifact)}`)))
      setArtifacts(sources); setEvidence(value)
    } catch { setStatus('error') }
    finally { setBusy(false) }
  }
  async function approve() {
    if (!evidence || !environment) return
    setBusy(true); setStatus(null)
    try {
      const approved = await request(`/api/factory/tasks/${evidence.binding.taskId}/approval`, { operation: 'approve', input: { binding: evidence.binding, eventId: crypto.randomUUID(), candidate: evidence.manifest.candidate, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: environment, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), evidenceDigest: evidence.evidenceDigest, evidenceReadId: evidence.evidenceReadId } })
      setApproval({ binding: approved.binding, approvalId: approved.approvalId, environment }); setEvidence(null); setStatus('approved'); void mutate()
    } catch { setStatus('error') }
    finally { setBusy(false) }
  }
  async function resume(taskId: string) {
    setBusy(true); setStatus(null); setApproval(null); setEvidence(null)
    try {
      const ledger = await request(`/api/factory/tasks/${taskId}/approval?view=ledger`)
      const record = currentSkillApproval(ledger.binding.candidateId, ledger.approvals, Date.now())
      if (hasRecordedSkillActivation(ledger.binding.candidateId, ledger.approvals, ledger.publications)) { setStatus('activated'); return true }
      if (!record) throw new Error('no active approval')
      const publication = [...ledger.publications].reverse().find((item: { approvalId: string; status: string }) => item.approvalId === record.id && item.status !== 'succeeded')
      setApproval({ binding: ledger.binding, approvalId: record.id, environment: record.targetEnvironment, publication }); return false
    } catch { setStatus('error'); return false }
    finally { setBusy(false) }
  }
  async function activate() {
    if (!approval) return
    setBusy(true); setStatus(null)
    try {
      const input = approval.publication ? { ...approval.publication.request, publicationId: approval.publication.id } : { binding: approval.binding, eventId: crypto.randomUUID(), approvalId: approval.approvalId, action: 'activate_skill', target: 'mikka-builtin:run-report', targetEnvironment: approval.environment }
      const result = await request(`/api/factory/tasks/${approval.binding.taskId}/approval`, { operation: approval.publication ? 'reconcile' : 'publish', input })
      if (!result.receipt) throw new Error('activation pending')
      setApproval(null); setStatus('activated'); void mutate()
    } catch { if (!await resume(approval.binding.taskId)) setStatus('error') }
    finally { setBusy(false) }
  }
  if (!error && !tasks.length && !status) return null
  return <section className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t('candidates')}</h3>{error && <p role="alert" className="text-xs">{t('error')}</p>}{tasks.map(task => <Button key={task.id} size="sm" variant="outline" disabled={busy} onClick={() => { void (task.stage === 'publish' ? resume(task.id) : review(task.id)) }}>{t(task.stage === 'publish' ? 'resume' : 'review')} · {task.id.slice(0, 8)}</Button>)}{evidence?.manifest.skill && <div className="flex min-w-0 flex-col gap-3"><h4 className="text-sm font-medium">{t('candidate')}</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(evidence.manifest.candidate, null, 2)}</pre><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{evidence.manifest.skill.markdown}</pre><h4 className="text-sm font-medium">{t('evaluation')}</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(evidence.manifest.skill.evaluation, null, 2)}</pre><h4 className="text-sm font-medium">{t('evidence')}</h4>{artifacts.map((artifact, index) => <pre key={evidence.manifest.artifacts[index].artifact} className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(artifact, null, 2)}</pre>)}<p className="text-sm">{t('environment')}</p><div className="flex gap-2">{(['preview', 'production'] as const).map(value => <Button key={value} size="sm" variant="outline" aria-pressed={environment === value} onClick={() => setEnvironment(value)}>{t(value)}</Button>)}</div><Button size="sm" disabled={busy || !environment} onClick={() => { void approve() }}>{t('approve')}</Button></div>}{approval && <div className="flex items-center gap-2"><span className="text-sm">{t(approval.environment === 'production' ? 'production' : 'preview')}</span><Button size="sm" disabled={busy} onClick={() => { void activate() }}>{t('activate')}</Button></div>}{status && <p role={status === 'error' ? 'alert' : 'status'} className="text-xs">{t(status)}</p>}</section>
}
