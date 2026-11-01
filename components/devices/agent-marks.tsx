import type { DeviceView } from '@/app/actions/agents'
import { HarnessMark } from '@/components/labels/entity-labels'

const AGENT_HARNESSES = new Set(['claude_code', 'codex', 'cursor'])

/** The coding agents a device reported, as their bare brand marks (R-74). */
export function installedAgents(harnesses: DeviceView['harnesses']): string[] {
  return harnesses.filter(item => item.installed && AGENT_HARNESSES.has(item.harness)).map(item => item.harness)
}

/** Agents a device found but cannot run, the packages it reported missing, and why the machine refused the sandbox. */
export function sandboxBlockedAgents(harnesses: DeviceView['harnesses']): { agents: string[]; missing: string[]; reason?: 'userns_restricted'; detail?: string } {
  const blocked = harnesses.filter(item => item.sandboxBlocked && AGENT_HARNESSES.has(item.harness))
  const issue = blocked[0]?.sandboxBlocked
  return {
    agents: blocked.map(item => item.harness), missing: issue?.missing ?? [],
    ...(issue?.reason ? { reason: issue.reason } : {}), ...(issue?.detail ? { detail: issue.detail } : {}),
  }
}

export function AgentMarks({ harnesses }: { harnesses: string[] }) {
  return <span className="inline-flex shrink-0 items-center gap-1">{harnesses.map(harness => <HarnessMark key={harness} harness={harness} />)}</span>
}

