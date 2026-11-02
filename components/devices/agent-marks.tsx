import type { DeviceView } from '@/app/actions/agents'
import { HarnessVersion } from '@/components/labels/entity-labels'

const AGENT_HARNESSES = new Set(['claude_code', 'codex', 'cursor'])

export interface InstalledAgent { harness: string; version: string | null }

/** The coding agents a device reported, with the version each CLI printed. */
export function installedAgents(harnesses: DeviceView['harnesses']): InstalledAgent[] {
  return harnesses.filter(item => item.installed && AGENT_HARNESSES.has(item.harness)).map(item => ({ harness: item.harness, version: item.version }))
}

/** The number from a CLI's version line: 「2.1.3 (Claude Code)」 and 「codex-cli 0.46.0」 read 2.1.3 and 0.46.0. */
export function agentVersion(version: string | null): string | null {
  return version?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null
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

/** Each agent's mark, name and version (R-74: a mark alone doesn't say which agent or how old it is). */
export function AgentMarks({ agents }: { agents: InstalledAgent[] }) {
  // `contents`: each agent wraps on its own in the status line, never mid-name.
  return <span className="contents">{agents.map(agent => <HarnessVersion key={agent.harness} harness={agent.harness} version={agentVersion(agent.version)} />)}</span>
}

