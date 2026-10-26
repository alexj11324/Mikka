import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { preload } from 'swr'
import { withBasePath } from '@/lib/base-path'
import type { AgentImageResult } from './agent-images'
import { agentImageQuery } from './agent-images'

export function agentImageKey(query: string) {
  return withBasePath(`/api/agent/images?q=${encodeURIComponent(query)}`)
}

export async function loadAgentImage(url: string): Promise<{ image: AgentImageResult | null }> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(agentCopy.imageSourcesAreTemporarilyUnavailableTheResponse)
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
