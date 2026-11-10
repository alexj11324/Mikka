/**
 * 模型与订阅 › 优先使用的模型 (decision 2026-11-02-1400): which allowed model a new
 * run takes, and where. Pure: the server reads the list, the credentials and
 * the devices (lib/model-order.ts) and asks this module; nothing here reads a
 * database or names a model.
 *
 * Each entry is an Agent and a model from one credential (a connected
 * subscription or an API key). A run takes the first entry that can run now:
 * its credential is usable (connected, not paused, quota left, the key not
 * refused), and 运行位置 has a place for it, tried in order (`PlanPlaces`):
 * 云端 the person's own E2B cloud, then servers, then computers; 本地 servers,
 * then computers. A device takes part when its 参与调度 is on, it is online,
 * the Agent is installed and, for a subscription model, it can take a
 * subscription run (its daemon brokers the subscription lease); among one
 * kind, the one with the fewest unfinished runs, then the one that joined
 * first (`pickDevice`). A model the person picked for the thread goes before
 * the list. Once a run starts nothing about it changes.
 */
import type { HarnessInfo, SubscriptionPreflightFailure } from '@mikka/protocol/harness'
import type { CloudModelState } from './cloud-template-models'

export type OrderHarness = 'claude_code' | 'codex'
export type RunLocation = 'cloud' | 'local'

export type EntrySource = { kind: 'subscription'; connectionId: string } | { kind: 'api_key'; keyId: string }

export interface OrderEntry {
  id: string
  harness: OrderHarness
  model: string
  source: EntrySource
}

/** Why a credential cannot run now; `resetsAt` when it comes back on its own. */
export type CredentialState =
  | { usable: true }
  | { usable: false; reason: 'checking' | 'quota' | 'expired' | 'paused' | 'missing' | 'removed' | 'modelGone' | 'keyRefused' | 'balance' | 'providerUnavailable'; resetsAt?: string | null }

export interface PoolDevice {
  id: string
  name: string
  online: boolean
  /** 参与调度: off means Mikka never sends a run here. */
  enabled: boolean
  /** A server (deviceType server) is used before a computer. */
  server: boolean
  /** Its runs not yet ended: the fewest goes first among the same kind. */
  activeRuns: number
  /** When it joined (ms): the earlier goes first on a tie. */
  joinedAt: number
  /** Last heartbeat; server reads normalize it to ms for the settings view. */
  lastSeenAt?: Date | string | number | null
  harnesses: readonly Pick<HarnessInfo, 'harness' | 'installed' | 'models' | 'modelSlots' | 'subscriptionBroker' | 'subscriptionModelCatalogue' | 'subscriptionPreflight'>[]
}

export type EntryBlock =
  | CredentialState & { usable: false }
  | { usable: false; reason: 'noDevice' }
  | { usable: false; reason: 'cloudNotConfigured' }
  | { usable: false; reason: 'cloudModelsUnknown' | 'cloudModelNotReported' }

export type DispatchPlan =
  | { kind: 'device'; entry: OrderEntry; deviceId: string; model: string; skipped: SkippedEntry[] }
  | { kind: 'cloud'; entry: OrderEntry; model: string; skipped: SkippedEntry[] }
  | { kind: 'none'; reason: NothingReason; skipped: SkippedEntry[] }

export interface SkippedEntry { entry: OrderEntry; block: EntryBlock }

/**
 * What the 没有能跑这个任务的模型 card says. noModels: the list is empty;
 * cloudNotConfigured: 云端 without an E2B key; noDevice: 本地 and no device
 * that takes part can run any allowed model; unavailable: every allowed
 * model's credential is out of quota, paused or signed out.
 */
export type NothingReason = 'noModels' | 'cloudNotConfigured' | 'cloudModelsUnknown' | 'cloudModelNotReported' | 'noDevice' | 'checking' | 'unavailable'

/** Credentials admit models; a device only supplies an installed Agent and
 * subscription injection. CLI shortcut menus never constrain full model IDs. */
export function deviceModel(device: PoolDevice, entry: OrderEntry): string | null {
  return deviceStage(device, entry) === 'ready' ? entry.model : null
}

export type DeviceStage = 'off' | 'offline' | 'notInstalled' | 'needsUpdate' | 'subscriptionRuntimeUnavailable' | 'ready'
export const DEVICE_STAGES: readonly DeviceStage[] = ['off', 'offline', 'notInstalled', 'needsUpdate', 'subscriptionRuntimeUnavailable', 'ready']

/** What a device can do for an entry whatever its 参与调度 or whether it is online (those come first in deviceStage). */
export function deviceSupport(device: Pick<PoolDevice, 'harnesses'>, entry: OrderEntry): Exclude<DeviceStage, 'off' | 'offline'> {
  const info = device.harnesses.find(item => item.harness === entry.harness)
  // A failed check wins over a stale broker flag. API-key runs do not use
  // subscription auth, so their existing installed-Agent path is unchanged.
  if (entry.source.kind === 'subscription' && info?.subscriptionPreflight) return 'subscriptionRuntimeUnavailable'
  if (!info?.installed) return 'notInstalled'
  if (entry.source.kind !== 'subscription') return 'ready'
  if (!info.subscriptionBroker) return 'needsUpdate'
  return 'ready'
}

/**
 * How far a device is from taking a run of this list, for the 运行位置 chain: its best
 * step over the runnable entries. With no entry it is judged on the preferred Agent alone.
 */
export function placeStage(device: PoolDevice, entries: readonly OrderEntry[], harness: OrderHarness): DeviceStage {
  if (!entries.length) {
    if (!device.enabled) return 'off'
    if (!device.online) return 'offline'
    return device.harnesses.some(info => info.harness === harness && info.installed) ? 'ready' : 'notInstalled'
  }
  return entries.map(entry => deviceStage(device, entry)).reduce((best, stage) => DEVICE_STAGES.indexOf(stage) > DEVICE_STAGES.indexOf(best) ? stage : best)
}

export function deviceStage(device: PoolDevice, entry: OrderEntry): DeviceStage {
  if (!device.enabled) return 'off'
  if (!device.online) return 'offline'
  return deviceSupport(device, entry)
}

/**
 * Why no device can run an entry, told from the device closest to running it:
 * none connected; 参与调度 off; offline; the Agent not installed; or its Mikka
 * too old to take a subscription run. `device` names that computer when it is
 * the only one at that step, `count` how many are.
 */
export type NoDeviceWhy = { why: 'none' } | { why: Exclude<DeviceStage, 'ready'>; device: string; count: number; detail?: SubscriptionPreflightFailure }

export function whyNoDevice(devices: readonly PoolDevice[], entry: OrderEntry): NoDeviceWhy {
  if (!devices.length) return { why: 'none' }
  const staged = devices.map(device => ({ device, stage: deviceStage(device, entry) }))
  const best = staged.reduce((top, item) => DEVICE_STAGES.indexOf(item.stage) > DEVICE_STAGES.indexOf(top.stage) ? item : top)
  const why = best.stage === 'ready' ? 'needsUpdate' : best.stage
  const detail = why === 'subscriptionRuntimeUnavailable' ? best.device.harnesses.find(info => info.harness === entry.harness)?.subscriptionPreflight : undefined
  return { why, device: best.device.name, count: staged.filter(item => item.stage === best.stage).length, ...(detail ? { detail } : {}) }
}

/**
 * Which of the devices that can run an entry takes it (Alex, 2026-11-02): a
 * server before a computer, then the one with the fewest unfinished runs
 * (threads run in parallel and no machine has a cap, so this spreads them),
 * then the one that joined first, then by id. Stable: the same devices and
 * runs give the same device, which the settings page shows as 会先用.
 */
export function pickDevice<T extends { device: Pick<PoolDevice, 'id' | 'server' | 'activeRuns' | 'joinedAt'> }>(eligible: readonly T[]): T | undefined {
  return [...eligible].sort((a, b) => Number(b.device.server) - Number(a.device.server)
    || a.device.activeRuns - b.device.activeRuns
    || a.device.joinedAt - b.device.joinedAt
    || (a.device.id < b.device.id ? -1 : a.device.id > b.device.id ? 1 : 0))[0]
}

/**
 * Where each 运行位置 looks, in order (Alex, 2026-11-02): 云端 the person's own
 * E2B cloud, then their servers, then their computers; 本地 servers, then
 * computers. A computer always comes last. `cloudOnly` is a run the person
 * asked to put in the cloud: nowhere else.
 */
export type PlanPlaces = RunLocation | 'cloudOnly'

export function planDispatch(input: {
  entries: readonly OrderEntry[]
  /** The model the person picked for this thread, when they did. */
  explicit?: OrderEntry | null
  location: PlanPlaces
  devices: readonly PoolDevice[]
  credential: (entry: OrderEntry) => CredentialState
  /** The person's own E2B key is set, not known to be refused, and cloud runs are on. */
  cloudReady: boolean
  cloudModel?: (entry: OrderEntry) => CloudModelState
}): DispatchPlan {
  const entries = input.explicit ? [input.explicit, ...input.entries.filter(entry => entry.id !== input.explicit!.id)] : [...input.entries]
  const skipped: SkippedEntry[] = []
  if (!entries.length) return { kind: 'none', reason: 'noModels', skipped }
  if (input.location === 'cloudOnly' && !input.cloudReady) {
    return { kind: 'none', reason: 'cloudNotConfigured', skipped: entries.map(entry => ({ entry, block: { usable: false, reason: 'cloudNotConfigured' } })) }
  }
  // The models whose credential can run now, in order, up to one whose allowance check failed:
  // a failed check is not evidence that a subscription is spent, so a later key is not charged instead.
  const runnable: OrderEntry[] = []
  let checking = false
  for (const entry of entries) {
    const credential = input.credential(entry)
    if (credential.usable) { runnable.push(entry); continue }
    skipped.push({ entry, block: credential })
    if (credential.reason === 'checking') { checking = true; break }
  }
  let cloudFailure: Exclude<CloudModelState, 'ready'> | undefined
  if (input.location !== 'local' && input.cloudReady) {
    for (const entry of runnable) {
      const state = input.cloudModel?.(entry) ?? 'cloudModelsUnknown'
      if (state === 'ready') return { kind: 'cloud', entry, model: entry.model, skipped }
      cloudFailure ??= state
      skipped.push({ entry, block: { usable: false, reason: state } })
    }
  }
  if (input.location !== 'cloudOnly') {
    // A server before a computer whatever the model: a later model on a server goes before an earlier one on a computer.
    for (const server of [true, false]) {
      const tier = input.devices.filter(device => device.server === server)
      for (const [at, entry] of runnable.entries()) {
        const eligible = tier.flatMap(device => {
          const model = deviceModel(device, entry)
          return model ? [{ device, model }] : []
        })
        if (!eligible.length) continue
        const pick = pickDevice(eligible)!
        // The models before it that this place cannot run (a place before it ran none of them).
        for (const earlier of runnable.slice(0, at)) skipped.push({ entry: earlier, block: { usable: false, reason: 'noDevice' } })
        return { kind: 'device', entry, deviceId: pick.device.id, model: pick.model, skipped }
      }
    }
  }
  if (checking) return { kind: 'none', reason: 'checking', skipped }
  if (cloudFailure) return { kind: 'none', reason: cloudFailure, skipped }
  for (const entry of runnable) skipped.push({ entry, block: { usable: false, reason: 'noDevice' } })
  return { kind: 'none', reason: runnable.length ? 'noDevice' : 'unavailable', skipped }
}

/**
 * The only model word written in code (decision 2026-11-02-1400, Alex): how an
 * untouched list puts Claude Code's opus first. It matches reported model ids
 * and names; a model nothing reported is never added.
 */
export const DEFAULT_ORDER_PREFERENCE: readonly { harness: OrderHarness; words: readonly string[] }[] = [
  { harness: 'claude_code', words: ['opus'] },
]

export interface OrderCandidate { harness: OrderHarness; model: string; name: string; source: EntrySource }

/** A catalogue may include historical releases. Only untouched defaults collapse
 * those releases; the complete catalogue remains available for manual choices.
 * Compare versions within a family and credential, never across accounts or tiers
 * (a new Opus does not retire Haiku, nor does a new Sol retire Luna). Catalogue
 * order breaks ties, so its recommended alias wins over an equivalent snapshot. */
export function latestDefaultCandidates<T extends OrderCandidate>(candidates: readonly T[]): T[] {
  const release = (model: string): { family: string; version: number[] } | undefined => {
    const id = model.toLowerCase().replace(/^(?:anthropic|openai)\//, '').replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
    const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?$/.exec(id)
    if (claude) return { family: `claude:${claude[1]}`, version: [Number(claude[2]), Number(claude[3] ?? 0)] }
    const legacyClaude = /^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable)$/.exec(id)
    if (legacyClaude) return { family: `claude:${legacyClaude[3]}`, version: [Number(legacyClaude[1]), Number(legacyClaude[2] ?? 0)] }
    const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z][a-z0-9-]*))?$/.exec(id)
    if (gpt) return { family: `gpt:${gpt[3] ?? 'default'}`, version: [Number(gpt[1]), Number(gpt[2] ?? 0)] }
  }
  const selected = new Map<string, { candidate: T; version: number[] }>()
  const families = new Map<T, string>()
  for (const candidate of candidates) {
    const current = release(candidate.model)
    if (!current) continue
    const source = candidate.source.kind === 'subscription' ? candidate.source.connectionId : candidate.source.keyId
    const key = `${candidate.harness}\u0000${candidate.source.kind}\u0000${source}\u0000${current.family}`
    families.set(candidate, key)
    const previous = selected.get(key)
    if (!previous || current.version[0] > previous.version[0] || (current.version[0] === previous.version[0] && current.version[1] > previous.version[1])) {
      selected.set(key, { candidate, version: current.version })
    }
  }
  return candidates.filter(candidate => {
    const family = families.get(candidate)
    return family === undefined || selected.get(family)?.candidate === candidate
  })
}

/**
 * The list a person who has not touched it gets, from what they connected and
 * what it reported (Alex, decision 2026-11-02-1400). Candidates come in the
 * order `orderCandidates` gives: Claude subscriptions, other subscriptions,
 * then keys, each in the order its account or provider listed its models.
 * A model both Agents can run (a DeepSeek or Kimi key) counts once, on the
 * preferred Agent (优先使用的 Agent, Claude Code unless changed).
 * - Claude Code's opus first, from a subscription before a key.
 * - Then Codex: the first model a subscription or key reported for it (the
 *   account lists its top model first; no tier word is required).
 * - Neither: the first model anything else reported, so the list is not empty.
 * Nothing connected: an empty list.
 */
export function defaultOrder(all: readonly OrderCandidate[], preferred: OrderHarness = 'claude_code', preserveSourceOrder = false): OrderCandidate[] {
  const candidates = onPreferredAgent(all, preferred)
  const bySource = (items: readonly OrderCandidate[]) => preserveSourceOrder ? items : [...items.filter(item => item.source.kind === 'subscription'), ...items.filter(item => item.source.kind !== 'subscription')]
  const picked: OrderCandidate[] = []
  for (const preference of DEFAULT_ORDER_PREFERENCE) {
    const match = bySource(candidates).find(candidate => candidate.harness === preference.harness
      && preference.words.some(word => `${candidate.model} ${candidate.name}`.toLowerCase().includes(word)))
    if (match) picked.push(match)
  }
  const codex = bySource(candidates).find(candidate => candidate.harness === 'codex')
  if (codex) picked.push(codex)
  if (!picked.length && candidates[0]) picked.push(candidates[0])
  return picked
}

/**
 * The untouched list: a default for each Agent, kept apart (decision 2026-11-05-0400). 优先使用的 Agent picks which
 * one the page shows and dispatch tries first; switching it never moves a stored row between them.
 */
export function defaultOrderByAgent(all: readonly OrderCandidate[], preferred: OrderHarness = 'claude_code', preserveSourceOrder = false): OrderCandidate[] {
  const seen = new Set<string>()
  // A model both Agents run stays on the 优先使用的 Agent, as before; each Agent's own models fill its list.
  return (['claude_code', 'codex'] as const).flatMap(harness => defaultOrder(onPreferredAgent(all, preferred).filter(candidate => candidate.harness === harness), harness, preserveSourceOrder))
    .filter(candidate => { const key = entryKey(candidate); if (seen.has(key)) return false; seen.add(key); return true })
}

/** The model and credential, whatever the Agent. */
export const offerKey = (entry: Pick<OrderEntry, 'model' | 'source'>) =>
  `${entry.model}\u0000${entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId}`

/** Which Agents can run each model and credential (a DeepSeek or Kimi key: both). */
export function agentsByOffer(candidates: readonly Pick<OrderCandidate, 'harness' | 'model' | 'source'>[]): Map<string, OrderHarness[]> {
  const agents = new Map<string, OrderHarness[]>()
  for (const candidate of candidates) {
    const list = agents.get(offerKey(candidate)) ?? []
    if (!list.includes(candidate.harness)) list.push(candidate.harness)
    agents.set(offerKey(candidate), list)
  }
  return agents
}

/** Candidates with a model both Agents run kept once, on the preferred Agent. */
export function onPreferredAgent<T extends Pick<OrderCandidate, 'harness' | 'model' | 'source'>>(candidates: readonly T[], preferred: OrderHarness): T[] {
  const agents = agentsByOffer(candidates)
  return candidates.filter(candidate => (agents.get(offerKey(candidate))?.length ?? 0) < 2 || candidate.harness === preferred)
}

/** The same Agent, model and credential: one entry. */
export const entryKey = (entry: Pick<OrderEntry, 'harness' | 'model' | 'source'>) =>
  `${entry.harness}\u0000${entry.model}\u0000${entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId}`

/**
 * The order dispatch tries with no Agent named (decision 2026-11-05-0400): the 优先使用的 Agent's own list first,
 * then the other Agent's list, each in its own order. The page shows only the first; the second is a fallback.
 */
export function dispatchOrder<T extends { harness: OrderHarness }>(entries: readonly T[], preferred: OrderHarness): T[] {
  return [...entries.filter(entry => entry.harness === preferred), ...entries.filter(entry => entry.harness !== preferred)]
}
