'use client'

import useSWR from 'swr'
import type { AgentHistory } from '@/lib/agent-history'
import { defaultAgentCopy } from '@/lib/agent-copy'
import { withBasePath } from '@/lib/base-path'

export async function fetchAgentHistory(url: string): Promise<AgentHistory> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? defaultAgentCopy.unableToRestoreChatHistory)
  return body
}

export function useAgentHistory(userId: string, initialHistory?: AgentHistory) {
  return useSWR<AgentHistory>(['/api/agent/sessions', userId], ([url]: [string, string]) => fetchAgentHistory(url), {
    fallbackData: initialHistory, revalidateOnFocus: false, revalidateIfStale: false,
  })
}
