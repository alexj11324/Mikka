'use client'

import useSWR from 'swr'
import type { DecisionReceipt } from './use-decision-submission'
import { webSelectionVersion } from '@/lib/web-connection/selection'
import { withBasePath } from '@/lib/base-path'
import { getIssue } from '@/app/actions/issues'
import { ReadResponseError } from '@/lib/swr/retry'

/** A pending Factory question as `/api/factory/questions` returns it (lib/factory/questions/ask-user.ts). */
export type FactoryQuestionItem = {
  questionId: string
  taskId: string
  runId: string
  status: string
  /** context · decision · permission · external */
  type: string
  question: string
  recordedAnswer?: string
  options: { label: string; value: string }[]
  reference: { questionRevision?: number; [key: string]: unknown }
  /** The task's title, read from its Factory task. */
  task: string
  /** The Mikka task (issue) it works on, when it has one. */
  issueId: string | null
}

async function json(path: string) {
  const response = await fetch(withBasePath(path), { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new ReadResponseError(response.status)
  return response.json() as Promise<Record<string, unknown>>
}

async function readQuestions(): Promise<FactoryQuestionItem[]> {
  const body = await json('/api/factory/questions')
  const questions = (body?.questions ?? []) as Omit<FactoryQuestionItem, 'task' | 'issueId'>[]
  const tasks = new Map<string, { title: string; issueId: string | null }>()
  await Promise.all([...new Set(questions.map(question => question.taskId))].map(async taskId => {
    const read = await json(`/api/factory/tasks/${taskId}`).catch(() => null)
    const issueId = (read?.task as { issueId?: string | null } | undefined)?.issueId ?? null
    // The task's words are its Mikka task's: its identifier and title.
    const issue = issueId ? await getIssue(issueId).catch(() => null) : null
    const view = issue && !issue.error ? issue.issue : null
    tasks.set(taskId, { title: view ? [view.identifier, view.title].filter(Boolean).join(' ') : '', issueId })
  }))
  return questions.map(question => ({ ...question, task: tasks.get(question.taskId)?.title ?? '', issueId: tasks.get(question.taskId)?.issueId ?? null }))
}

const answerable = (status: string) => status === 'open' || status === 'waiting_user'

export function factoryQuestionUnavailable(status: string): string | undefined {
  if (answerable(status)) return
  return status === 'expired' ? 'factoryQuestionExpired' : 'factoryQuestionClosed'
}

// An identical retry from another entry or after reload must address the same answer on this revision.
async function operationId(question: FactoryQuestionItem, text: string) {
  const revision = question.reference.questionRevision
  const payload = JSON.stringify(['mikka.factory.answer', question.questionId, revision, text])
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))).slice(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x80
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function submitQuestion(question: FactoryQuestionItem, text: string): Promise<DecisionReceipt> {
  const unavailable = factoryQuestionUnavailable(question.status)
  if (unavailable) return { status: 'unavailable', error: unavailable }
  const path = withBasePath(`/api/factory/questions/${question.questionId}`)
  const selection = webSelectionVersion()
  const changed = (): DecisionReceipt => ({ status: 'unavailable', error: 'decisionAccountChanged' })
  const answerId = await operationId(question, text)
  if (selection !== webSelectionVersion()) return changed()
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference: question.reference, answerId, text }),
  }).catch(() => null)
  const body = await response?.json().catch(() => null)
  if (selection !== webSelectionVersion()) return changed()
  if (response?.ok && body?.questionId === question.questionId && typeof body.continuationRunId === 'string' && body.continuationRunId) return { status: 'accepted' }
  if (response && [401, 403, 404].includes(response.status)) return { status: 'unavailable', error: body?.error ?? 'decisionUnavailable' }
  if (response && response.status >= 400 && response.status < 500 && response.status !== 409) return { status: 'failed', error: body?.error ?? 'actionFailed' }

  // A refused revision or missing acknowledgement is reconciled with this same actor's authorized read.
  const reread = await fetch(path, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null)
  const current = await reread?.json().catch(() => null)
  if (selection !== webSelectionVersion()) return changed()
  if (reread?.ok && current?.id === question.questionId) {
    if (current.answerId === answerId && current.continuationRunId) return { status: 'accepted' }
    const closed = factoryQuestionUnavailable(current.status)
    if (current.answerId || closed) return { status: 'unavailable', error: closed ?? 'factoryQuestionClosed' }
    if (current.reference?.questionRevision !== question.reference.questionRevision)
      return { status: 'unavailable', error: 'factoryQuestionChanged' }
    return { status: 'failed', error: body?.error ?? 'decisionRetry' }
  }
  if (reread && [401, 403, 404].includes(reread.status)) return { status: 'unavailable', error: current?.error ?? 'decisionUnavailable' }
  return { status: 'uncertain', error: 'decisionUnconfirmed' }
}

/**
 * The `version` 收件箱 reads its questions at: the live thread list's ids and states, so a task that moves reads them
 * again. The rail's count (hooks/use-inbox-count.ts) passes the same one and shares the read.
 */
export function factoryQuestionsVersion(threads: readonly { id: string; status: string }[]) {
  return threads.map(thread => `${thread.id}:${thread.status}`).join(',')
}

/**
 * The person's pending Factory questions, and answering one. No timer reads them (#1212): `version` is something that
 * changes when they may have (the chat's own version, the task list), and a change reads them again.
 */
export function useFactoryQuestions(version: unknown, enabled = true) {
  const { data, error, mutate } = useSWR(enabled ? ['factory-questions', version] : null, readQuestions, { revalidateOnFocus: false, keepPreviousData: true })
  async function submitAnswer(question: FactoryQuestionItem, text: string): Promise<DecisionReceipt> {
    const result = await submitQuestion(question, text)
    if (result.status === 'accepted') await mutate()
    return result
  }
  // The preceding hosted release still uses the error-or-null callback.
  async function answer(question: FactoryQuestionItem, text: string): Promise<string | null> {
    const result = await submitAnswer(question, text)
    return result.status === 'accepted' ? null : result.error
  }
  return { questions: data ?? [], error: error ?? null, reload: () => mutate(), answer, submitAnswer }
}
