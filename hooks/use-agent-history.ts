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
    // issue-workspace 和 legacy-chat-archive 共用这个键；冷启动时首个请求可能超过默认 2 秒去重窗口，
    // 导致面板挂载时重复请求（MIK-1）。拉长窗口让两处共享同一个在途请求。
    dedupingInterval: 15_000,
  })
}
