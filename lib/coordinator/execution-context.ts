/**
 * What the Bot knows each turn about where the person's work can run, so it
 * never asks for something they already set up: the workspace, their
 * computers, the allowed models (模型与订阅) and 运行位置, the subscriptions
 * and API keys connected, their E2B key, and whether Mikka 默认 can answer.
 * Each part has its own time limit; a part that cannot be read is left out,
 * never reported as missing. No credential, balance or id is written here.
 */
export interface ExecutionFacts {
  workspace: { name: string; kind: 'personal' | 'team' } | null
  devices: { name: string; online: boolean; enabled: boolean; agents: string[] }[] | null
  order: { location: 'local' | 'cloud'; entries: { agent: string; model: string; provider: string; block: string | null }[]; credentials: { kind: 'subscription' | 'api_key'; provider: string }[] } | null
  e2b: boolean | null
  /** Mikka 默认's state in this workspace (lib/billing/hosted-usage.ts HOSTED_STATES). */
  hosted: string | null
}

export type ExecutionContextSource = { [Key in keyof ExecutionFacts]: (userId: string, botId: string) => Promise<ExecutionFacts[Key]> }

const AGENT: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' }
const agentName = (harness: string) => AGENT[harness] ?? harness

const scopeFor = async (userId: string, botId: string) => ({ ownerId: userId, workspaceId: await (await import('@/lib/execution-settings')).executionWorkspace(userId, botId) })

const source: ExecutionContextSource = {
  workspace: async (userId, botId) => {
    const { workspaceId } = await scopeFor(userId, botId)
    const { workspacePool } = await import('@/lib/workspace-db')
    const row = (await workspacePool.query<{ name: string; kind: 'personal' | 'team' }>('SELECT name,kind FROM mikka_workspaces WHERE id=$1', [workspaceId])).rows[0]
    return row ? { name: row.name, kind: row.kind } : null
  },
  devices: async userId => {
    const [{ pool }, { poolDevices }] = await Promise.all([import('@/lib/db'), import('@/lib/model-order')])
    return (await poolDevices(pool, userId)).map(device => ({ name: device.name, online: device.online, enabled: device.enabled, agents: device.harnesses.filter(item => item.installed).map(item => agentName(item.harness)) }))
  },
  order: async (userId, botId) => {
    const [{ pool }, { orderView }] = await Promise.all([import('@/lib/db'), import('@/lib/model-order')])
    const view = await orderView(pool, await scopeFor(userId, botId))
    const credentials = new Map(view.candidates.map(candidate => [`${candidate.source.kind}:${candidate.provider}`, { kind: candidate.source.kind, provider: candidate.provider }]))
    return {
      location: view.location,
      entries: view.entries.map(entry => ({ agent: agentName(entry.harness), model: entry.model, provider: entry.provider, block: entry.block?.reason ?? null })),
      credentials: [...credentials.values()],
    }
  },
  e2b: async userId => {
    const [{ pool }, { ownE2BKeySql }] = await Promise.all([import('@/lib/db'), import('@/lib/secrets/e2b-owner-sql')])
    return (await pool.query(`SELECT 1 WHERE ${ownE2BKeySql('$1::text')}`, [userId])).rowCount !== 0
  },
  hosted: async (userId, botId) => {
    const { workspaceId } = await scopeFor(userId, botId)
    const { hostedUsage } = await import('@/lib/abuse/runtime')
    return (await hostedUsage.status(workspaceId)).state
  },
}

/** A slow source never holds up the turn: past this its part is left out. */
const PART_TIMEOUT_MS = 3_000
/** The allowed models shown; dispatch_run reads the rest itself. */
const SHOWN_MODELS = 3

async function read<T>(work: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work().catch(() => null),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

export async function readExecutionFacts(userId: string, botId: string, from: ExecutionContextSource = source, timeoutMs = PART_TIMEOUT_MS): Promise<ExecutionFacts> {
  const [workspace, devices, order, e2b, hosted] = await Promise.all([
    read(() => from.workspace(userId, botId), timeoutMs),
    read(() => from.devices(userId, botId), timeoutMs),
    read(() => from.order(userId, botId), timeoutMs),
    read(() => from.e2b(userId, botId), timeoutMs),
    read(() => from.hosted(userId, botId), timeoutMs),
  ])
  return { workspace, devices, order, e2b, hosted }
}

/** The facts as prompt lines. Empty when nothing could be read. */
export function executionContextText(facts: ExecutionFacts): string {
  const lines: string[] = []
  if (facts.workspace) lines.push(`Workspace of this chat: ${facts.workspace.name} (${facts.workspace.kind}).`)
  if (facts.devices) {
    lines.push(facts.devices.length
      ? `The person's computers: ${facts.devices.map(device => `${device.name} (${device.online ? 'online' : 'offline'}${device.enabled ? '' : ', 参与调度 off'}${device.agents.length ? `, ${device.agents.join(' and ')}` : ', no Agent installed'})`).join('; ')}.`
      : 'The person has no computer connected.')
  }
  if (facts.order) {
    const { location, entries, credentials } = facts.order
    lines.push(credentials.length
      ? `Connected for threads: ${credentials.map(item => `${item.provider} ${item.kind === 'subscription' ? 'subscription' : 'API key'}`).join(', ')}.`
      : 'No subscription or API key is connected for threads; dispatch_run returns a card that leads to adding one.')
    if (entries.length) {
      const shown = entries.slice(0, SHOWN_MODELS).map(entry => `${entry.agent} ${entry.model}${entry.block ? ` (cannot run now: ${entry.block})` : ''}`)
      lines.push(`Preferred models in order (优先使用的模型, ${location === 'cloud' ? '运行位置 云端: their E2B cloud, then a server, then a computer' : '运行位置 本地: a server, then a computer'}): ${shown.join('; ')}${entries.length > SHOWN_MODELS ? `; and ${entries.length - SHOWN_MODELS} more` : ''}.`)
    }
  }
  if (facts.e2b !== null) lines.push(facts.e2b ? 'The person has their own E2B key, so cloud runs are possible.' : 'The person has no E2B key: nothing runs in the cloud until they add one, so 运行位置 云端 uses a server or a computer.')
  if (facts.hosted && !['ready', 'usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'].includes(facts.hosted)) lines.push(`Mikka 默认 (the model for Bot chats) cannot answer right now: ${facts.hosted}. The person sees this on the chat.`)
  if (!lines.length) return ''
  lines.push('These are already known: do not ask the person about them; use them, and the tools, to act.')
  return lines.join('\n')
}

export async function executionContext(userId: string, botId: string, from: ExecutionContextSource = source, timeoutMs = PART_TIMEOUT_MS): Promise<string> {
  return executionContextText(await readExecutionFacts(userId, botId, from, timeoutMs))
}
