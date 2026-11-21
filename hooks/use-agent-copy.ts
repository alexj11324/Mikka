'use client'

import { useMessages } from '@/lib/intl/i18n-client'
import type { AgentCopy } from '@/lib/agent-copy'

export function useAgentCopy(): AgentCopy {
  return useMessages().AgentCopy as AgentCopy
}
