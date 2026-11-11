'use client'

import useSWR from 'swr'
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
  options: { label: string; value: string }[]
  reference: unknown
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
  /** Answers with `text` (the option's label or the person's own words); null when it went, else the error code. */
  async function answer(question: FactoryQuestionItem, text: string): Promise<string | null> {
    const response = await fetch(withBasePath(`/api/factory/questions/${question.questionId}`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: question.reference, answerId: crypto.randomUUID(), text }),
    }).catch(() => null)
    await mutate()
    if (response?.ok) return null
    const body = await response?.json().catch(() => null) as { error?: string } | null
    return body?.error ?? 'actionFailed'
  }
  return { questions: data ?? [], error: error ?? null, reload: () => mutate(), answer }
}
