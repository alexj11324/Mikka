'use client'

import { useMemo } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { useSuggestions } from '@/components/suggestions/suggestion-feed'
import { inboxCount } from './use-bot-tasks'
import { factoryQuestionsVersion, useFactoryQuestions } from './use-factory-questions'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/**
 * The count on 收件箱: exactly what its list holds (inboxSelection), from the same reads in the current workspace:
 * its live thread and task lists, its pending Factory questions and its suggestions. `enabled` false (a frame that
 * shows no count) reads nothing and counts 0.
 */
export function useInboxCount(threads: Thread[], issues: Issue[], enabled: boolean) {
  const version = useMemo(() => factoryQuestionsVersion(threads), [threads])
  const { questions } = useFactoryQuestions(version, enabled)
  const { items: suggestions } = useSuggestions(enabled)
  return useMemo(() => enabled ? inboxCount(threads, issues, questions, suggestions.length) : 0, [enabled, threads, issues, questions, suggestions.length])
}
