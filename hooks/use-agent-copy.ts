'use client'

import { useMessages } from 'next-intl'
import type { AgentCopy } from '@/lib/agent-copy'

export function useAgentCopy(): AgentCopy {
  return useMessages().AgentCopy as AgentCopy
}
