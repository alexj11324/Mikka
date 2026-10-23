'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { fetchAgentHistory } from '@/hooks/use-agent-history'
import type { AgentHistory } from '@/lib/agent-history'
import { withBasePath } from '@/lib/base-path'
import { agentIsWorking, nextTrackedWorkers, workersFromActiveAgents, type ActiveAgentsResponse, type TrackedWorker, type Worker } from '@/lib/working-status'

type Source = { key: readonly [string, string]; fetch: (url: string) => Promise<unknown>; toWorkers: (data: unknown, agentName: string) => Worker[]; busy: (data: unknown) => boolean }

/** Default: the person's own Agent, working while its latest session has a pending turn. */
const sessionsSource: Source = {
  key: ['/api/agent/sessions', 'working-status'],
  fetch: fetchAgentHistory,
  toWorkers: (data, agentName) => agentIsWorking(data as AgentHistory | undefined) ? [{ id: 'agent', name: agentName }] : [],
  busy: data => agentIsWorking(data as AgentHistory | undefined),
}

/** MIK-7 read-only running-agents API. Not deployed yet. */
const activeAgentsSource: Source = {
  key: ['/api/agent/sessions/active', 'working-status'],
  fetch: async url => {
    const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error(`active agents ${response.status}`)
    return response.json() as Promise<ActiveAgentsResponse>
  },
  toWorkers: data => workersFromActiveAgents(data as ActiveAgentsResponse | undefined),
  busy: data => workersFromActiveAgents(data as ActiveAgentsResponse | undefined).length > 0,
}
void activeAgentsSource

// Switch to `activeAgentsSource` once MIK-7 ships.
const SOURCE: Source = sessionsSource

/** Who is working right now, with removal hysteresis applied per poll. */
export function useWorkingParticipants({ coordinatorWorking }: { coordinatorWorking: boolean }): Worker[] {
  const t = useTranslations('Coordinator.workingStatus')
  const { data } = useSWR(SOURCE.key, ([url]: readonly [string, string]) => SOURCE.fetch(url), {
    refreshInterval: latest => SOURCE.busy(latest) ? 2000 : 10000, revalidateOnFocus: false,
  })
  const [tracked, setTracked] = useState<TrackedWorker[]>([])
  useEffect(() => {
    // Each new poll result (from either source) counts as one confirmation.
    const current: Worker[] = [
      ...(coordinatorWorking ? [{ id: 'coordinator', name: t('coordinator') }] : []),
      ...SOURCE.toWorkers(data, t('agent')),
    ]
    setTracked(previous => nextTrackedWorkers(previous, current))
  }, [data, coordinatorWorking, t])
  return tracked
}
