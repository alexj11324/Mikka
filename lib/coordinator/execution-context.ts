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
  order: {
    location: 'local' | 'cloud'
    /** 优先使用的模型, every entry in its order: what it is, where it can run, and why it cannot run now (null when it can). */
    entries: { harness: string; agent: string; model: string; source: 'subscription' | 'api_key'; provider: string; places: string[]
      /** The person's servers and computers whose daemon cannot run it, each with why (from what the daemon reported, not whether it is online). */
      unsupported?: string[]; block: string | null }[]
    credentials: { kind: 'subscription' | 'api_key'; provider: string }[]
  } | null
  e2b: boolean | null
  /** Mikka 默认's state in this workspace (lib/billing/hosted-usage.ts HOSTED_STATES). */
  hosted: string | null
}

export type ExecutionContextSource = { [Key in keyof ExecutionFacts]: (userId: string, botId: string) => Promise<ExecutionFacts[Key]> }

const AGENT: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' }
const agentName = (harness: string) => AGENT[harness] ?? harness
/** Why a server or computer cannot run a model, from what its daemon reported. */
const WHY: Record<'notInstalled' | 'modelNotReported' | 'needsUpdate' | 'ready', string> = {
  ready: '',
  notInstalled: 'Agent not installed', modelNotReported: 'its daemon did not report this model', needsUpdate: 'its Mikka is too old to report its models',
}

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
    const [{ pool }, { dispatchOrder, orderView, poolDevices }] = await Promise.all([import('@/lib/db'), import('@/lib/model-order')])
    const [view, devices] = await Promise.all([orderView(pool, await scopeFor(userId, botId)), poolDevices(pool, userId)])
    const credentials = new Map(view.candidates.map(candidate => [`${candidate.source.kind}:${candidate.provider}`, { kind: candidate.source.kind, provider: candidate.provider }]))
    // Where each model can run: the person's own E2B cloud when it takes runs, and each server or computer whose daemon
    // reported it (lib/model-order-plan.ts deviceSupport). Online and 参与调度 change from turn to turn, so they are left to the tail.
    const { deviceSupport } = await import('@/lib/model-order-plan')
    const label = (device: (typeof devices)[number]) => `${device.name} (${device.server ? 'server' : 'computer'})`
    const support = (entry: (typeof view.entries)[number]) => devices.map(device => ({ device, stage: deviceSupport(device, entry) }))
    const places = (entry: (typeof view.entries)[number]) => [...(view.cloudReady && view.cloudModels[entry.id] === 'ready' ? ['cloud'] : []), ...support(entry).filter(item => item.stage === 'ready').map(item => label(item.device)).sort()]
    const unsupported = (entry: (typeof view.entries)[number]) => support(entry).filter(item => item.stage !== 'ready').map(item => `${label(item.device)}: ${WHY[item.stage]}`).sort()
    return {
      location: view.location,
      // In the order a new thread tries them: the 优先使用的 Agent's list, then the other's (decision 2026-11-05-0400).
      entries: dispatchOrder(view.entries, view.preferredHarness).map(entry => ({ harness: entry.harness, agent: agentName(entry.harness), model: entry.model, source: entry.source.kind, provider: entry.provider, places: places(entry), unsupported: unsupported(entry), block: entry.block?.reason ?? null })),
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

/**
 * 优先使用的模型 as prompt lines for the cached prefix: every entry, in order, with its Agent, model id, credential and
 * where it can run. Whether one can run right now is in executionContextText, which changes from turn to turn.
 * The same list always gives the same bytes. Empty when the list could not be read.
 */
export function modelListText(facts: Pick<ExecutionFacts, 'order'>): string {
  if (!facts.order) return ''
  const { location, entries } = facts.order
  if (!entries.length) return 'Allowed models (优先使用的模型): none yet. dispatch_run returns a card that leads to adding a subscription or an API key.'
  const place = location === 'cloud' ? '运行位置 云端: their E2B cloud, then a server, then a computer' : '运行位置 本地: a server, then a computer'
  return [
    `Allowed models (优先使用的模型), in the order a new thread tries them (${place}). dispatch_run and dispatch_bot_computer take only these. A subscription model runs only where a machine's daemon reported it:`,
    ...entries.map((entry, index) => `${index + 1}. ${entry.agent} (${entry.harness}) ${entry.model} · ${entry.provider} ${entry.source === 'subscription' ? 'subscription' : 'API key (its models are the provider\'s list; a machine needs only the Agent)'} · runs on: ${entry.places.length ? entry.places.join(', ') : 'nowhere yet'}${entry.unsupported?.length ? ` · not on: ${entry.unsupported.join('; ')}` : ''}`),
  ].join('\n')
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
    const { entries, credentials } = facts.order
    lines.push(credentials.length
      ? `Connected for threads: ${credentials.map(item => `${item.provider} ${item.kind === 'subscription' ? 'subscription' : 'API key'}`).join(', ')}.`
      : 'No subscription or API key is connected for threads; dispatch_run returns a card that leads to adding one.')
    // The list itself is in the cached prefix (modelListText); here only what changes from turn to turn.
    const blocked = entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.block)
    if (entries.length) lines.push(blocked.length
      ? `Allowed models that cannot run right now: ${blocked.map(item => `${item.index + 1}. ${item.entry.agent} ${item.entry.model} (${item.entry.block})`).join('; ')}. The others can.`
      : 'Every allowed model can run now.')
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

/** The turn's execution facts split for the prompt cache: the allowed models list (cached prefix) and the rest (per turn). */
export async function executionContextParts(userId: string, botId: string, from: ExecutionContextSource = source, timeoutMs = PART_TIMEOUT_MS): Promise<{ models: string; live: string }> {
  const facts = await readExecutionFacts(userId, botId, from, timeoutMs)
  return { models: modelListText(facts), live: executionContextText(facts) }
}
