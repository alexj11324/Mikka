import { preload } from 'swr'
import type { AgentImageResult } from './agent-images'
import { agentImageQuery } from './agent-images'

export function agentImageKey(query: string) {
  return `/api/agent?q=${encodeURIComponent(query)}`
}

export async function loadAgentImage(url: string): Promise<{ image: AgentImageResult | null }> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('图片来源暂时不可用，正文不受影响。')
  const data: { image: AgentImageResult | null } = await response.json()
  if (data.image && typeof Image !== 'undefined') {
    const image = new Image()
    image.src = data.image.src
  }
  return data
}

export function preloadAgentImage(query: string) {
  if (!agentImageQuery.safeParse(query).success) return
  // SWR shares this in-flight lookup with the card when it mounts.
  void preload(agentImageKey(query), loadAgentImage).catch(() => {})
}
