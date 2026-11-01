/** 运行信息 as the server sends it on a thread (lib/run-info-view.ts there), and its one line. */
export type RunMachine = { kind: 'cloud' } | { kind: 'device'; name: string }
export interface RunInfo {
  machine: RunMachine | null
  harness: string | null
  model: string | null
  payer: { provider: string; plan: string | null; ownerName: string | null } | null
  movedTo: RunMachine | null
}

const HARNESS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }
const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT' }
const machineName = (machine: RunMachine) => machine.kind === 'cloud' ? 'E2B' : machine.name

/** 「my-server · Claude Sonnet · Alex 的 Claude Max」, then 「已换到 E2B 继续」 after a move; null with nothing frozen. */
export function runInfoLine(info: RunInfo | undefined): string | null {
  if (!info) return null
  const parts: string[] = []
  if (info.machine) parts.push(machineName(info.machine))
  const model = info.model ?? (info.harness ? HARNESS[info.harness] ?? info.harness : null)
  if (model) parts.push(model)
  if (info.payer) {
    const plan = [PROVIDER[info.payer.provider] ?? info.payer.provider, info.payer.plan].filter(Boolean).join(' ')
    parts.push(info.payer.ownerName ? `${info.payer.ownerName} 的 ${plan}` : plan)
  }
  if (info.movedTo) parts.push(`已换到 ${machineName(info.movedTo)} 继续`)
  return parts.length ? parts.join(' · ') : null
}
