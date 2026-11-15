'use client'

import { createContext } from 'react'
import type { Thread } from '@/app/actions/task-runs'
import type { GroupSummary } from '@/lib/group-messages'

type RunList = {
  live?: { ownerId: string; workspaceId: string | null }
  items?: readonly Pick<Thread, 'id' | 'title'>[]
}

export const ConversationReferenceTitles = createContext<ReadonlyMap<string, string>>(new Map())

/** Both lists already belong to the mounted workspace. Keep identical run and chat UUIDs independent. */
export function conversationReferenceTitles(ownerId: string, workspaceId: string | undefined, runs: RunList | undefined, groups: readonly GroupSummary[]): ReadonlyMap<string, string> {
  const titles = new Map<string, string>()
  if (!workspaceId) return titles
  if (runs?.live?.ownerId === ownerId && runs.live.workspaceId === workspaceId) {
    for (const run of runs.items ?? []) if (run.title) titles.set('run:' + run.id, run.title)
  }
  for (const group of groups) {
    if (group.workspaceId === workspaceId && group.creationPurpose === 'conversation' && group.title) titles.set('chat:' + group.id, group.title)
  }
  return titles
}
