'use client'

import { useMemo } from 'react'
import type { Thread } from '@/app/actions/task-runs'
import { useSuggestionCount } from '@/components/suggestions/suggestion-feed'
import { waitingTasks, type CollectionGroups } from '@/lib/task-collection'
import { factoryQuestionsVersion, useFactoryQuestions } from './use-factory-questions'

/**
 * The count on 收件箱: exactly what its list holds, from the same reads in the current workspace:
 * its live thread and task lists, its pending Factory questions and its suggestions (their read-only count, so the
 * badge writes no briefing and wakes nothing). `enabled` false (a frame that shows no count) reads nothing and counts 0.
 */
export function useInboxCount(threads: Thread[], groups: CollectionGroups, enabled: boolean) {
  const version = useMemo(() => factoryQuestionsVersion(threads), [threads])
  const { questions } = useFactoryQuestions(version, enabled)
  const suggestions = useSuggestionCount(enabled)
  return useMemo(() => enabled ? questions.length + waitingTasks(groups, questions).length + suggestions : 0, [enabled, groups, questions, suggestions])
}
