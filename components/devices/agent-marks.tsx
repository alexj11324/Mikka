import type { DeviceView } from '@/app/actions/agents'
import { HarnessMark } from '@/components/labels/entity-labels'

const AGENT_HARNESSES = new Set(['claude_code', 'codex', 'cursor'])

/** The coding agents a device reported, as their bare brand marks (R-74). */
export function installedAgents(harnesses: DeviceView['harnesses']): string[] {
  return harnesses.filter(item => item.installed && AGENT_HARNESSES.has(item.harness)).map(item => item.harness)
}

export function AgentMarks({ harnesses }: { harnesses: string[] }) {
  return <span className="inline-flex shrink-0 items-center gap-1">{harnesses.map(harness => <HarnessMark key={harness} harness={harness} />)}</span>
}

