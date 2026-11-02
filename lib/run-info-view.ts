/*
 * 运行信息 under a thread: where it ran, on what, who pays (lib/run-info.ts
 * reads it). No server imports, so the web and phone clients can use it.
 */

export type RunMachine = { kind: 'cloud' } | { kind: 'device'; name: string }

export interface RunInfo {
  /** The machine: a device by name, or the cloud (E2B). */
  machine: RunMachine | null
  /** The Agent that ran it (claude_code, codex…). */
  harness: string | null
  /** The model, when one was frozen for the run. */
  model: string | null
  /** Whose subscription pays, when the run was pinned to one. */
  payer: { provider: string; plan: string | null; ownerName: string | null } | null
  /** Where it went on after its machine was lost. */
  movedTo: RunMachine | null
}

const HARNESS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }
const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT' }

export const machineName = (machine: RunMachine) => machine.kind === 'cloud' ? 'E2B' : machine.name

/**
 * The line's parts, in order: machine · model (or the Agent) · who pays.
 * `paidBy` words the payer, e.g. 「Alex 的 Claude Max」.
 */
export function runInfoParts(info: RunInfo, paidBy: (owner: string, plan: string) => string): string[] {
  const parts: string[] = []
  if (info.machine) parts.push(machineName(info.machine))
  const model = info.model ?? (info.harness ? HARNESS[info.harness] ?? info.harness : null)
  if (model) parts.push(model)
  if (info.payer) {
    const plan = [PROVIDER[info.payer.provider] ?? info.payer.provider, info.payer.plan].filter(Boolean).join(' ')
    parts.push(info.payer.ownerName ? paidBy(info.payer.ownerName, plan) : plan)
  }
  return parts
}
