/**
 * 模型与订阅 › 优先使用的模型 (decision 2026-11-02-1400): which allowed model a new
 * run takes, and where. Pure: the server reads the list, the credentials and
 * the devices (lib/model-order.ts) and asks this module; nothing here reads a
 * database or names a model.
 *
 * Each entry is an Agent and a model from one credential (a connected
 * subscription or an API key). A run takes the first entry that can run now:
 * its credential is usable (connected, not paused, quota left, the key not
 * refused), and the run location has a place for it. 本地: a device whose
 * 参与调度 is on, online, with the Agent installed and, for a subscription
 * model, able to take a subscription run (its daemon brokers the subscription
 * lease); servers before computers, then the one with the fewest unfinished
 * runs, then the one that joined first (`pickDevice`). 云端:
 * the person's own E2B key is set. A model the person picked for the thread
 * goes before the list. Once a run starts nothing about it changes.
 */
import type { HarnessInfo } from '@mikka/protocol/harness'

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
  | { usable: false; reason: 'quota' | 'expired' | 'paused' | 'missing' | 'keyRefused'; resetsAt?: string | null }

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
  harnesses: readonly Pick<HarnessInfo, 'harness' | 'installed' | 'models' | 'modelSlots' | 'subscriptionBroker'>[]
}

export type EntryBlock =
  | CredentialState & { usable: false }
  | { usable: false; reason: 'noDevice' }
  | { usable: false; reason: 'cloudNotConfigured' }

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
export type NothingReason = 'noModels' | 'cloudNotConfigured' | 'noDevice' | 'unavailable'

/**
 * The model a device runs for an entry: the slot its CLI reported for it, or
 * the model itself. Null when the device cannot run the entry: 参与调度 off,
 * offline, the Agent not installed, or (for a subscription model) the daemon
 * cannot take a subscription run (no `subscriptionBroker`: the claim is
 * refused without it). A subscription's model is what its account offers, so
 * the CLI need not have reported it; the run passes the model to the CLI. An
 * API key's model runs on any installed Agent of the key's protocol, since the
 * key is handed to the run.
 */
export function deviceModel(device: PoolDevice, entry: OrderEntry): string | null {
  return deviceStage(device, entry) === 'ready' ? runModel(device, entry) : null
}

type DeviceStage = 'off' | 'offline' | 'notInstalled' | 'needsUpdate' | 'ready'
const STAGES: readonly DeviceStage[] = ['off', 'offline', 'notInstalled', 'needsUpdate', 'ready']

function deviceStage(device: PoolDevice, entry: OrderEntry): DeviceStage {
  if (!device.enabled) return 'off'
  if (!device.online) return 'offline'
  const info = device.harnesses.find(item => item.harness === entry.harness && item.installed)
  if (!info) return 'notInstalled'
  if (entry.source.kind === 'subscription' && !info.subscriptionBroker) return 'needsUpdate'
  return 'ready'
}

function runModel(device: PoolDevice, entry: OrderEntry): string {
  if (entry.source.kind === 'api_key') return entry.model
  const info = device.harnesses.find(item => item.harness === entry.harness && item.installed)
  return info?.modelSlots?.find(item => item.slot === entry.model || item.model === entry.model)?.slot ?? entry.model
}

/**
 * Why no device can run an entry, told from the device closest to running it:
 * none connected; 参与调度 off; offline; the Agent not installed; or its Mikka
 * too old to take a subscription run. `device` names that computer when it is
 * the only one at that step, `count` how many are.
 */
export type NoDeviceWhy = { why: 'none' } | { why: Exclude<DeviceStage, 'ready'>; device: string; count: number }

export function whyNoDevice(devices: readonly PoolDevice[], entry: OrderEntry): NoDeviceWhy {
  if (!devices.length) return { why: 'none' }
  const staged = devices.map(device => ({ device, stage: deviceStage(device, entry) }))
  const best = staged.reduce((top, item) => STAGES.indexOf(item.stage) > STAGES.indexOf(top.stage) ? item : top)
  const why = best.stage === 'ready' ? 'needsUpdate' : best.stage
  return { why, device: best.device.name, count: staged.filter(item => item.stage === best.stage).length }
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

export function planDispatch(input: {
  entries: readonly OrderEntry[]
  /** The model the person picked for this thread, when they did. */
  explicit?: OrderEntry | null
  location: RunLocation
  devices: readonly PoolDevice[]
  credential: (entry: OrderEntry) => CredentialState
  /** 云端: the person's own E2B key is set and cloud runs are on. */
  cloudReady: boolean
}): DispatchPlan {
  const entries = input.explicit ? [input.explicit, ...input.entries.filter(entry => entry.id !== input.explicit!.id)] : [...input.entries]
  const skipped: SkippedEntry[] = []
  if (!entries.length) return { kind: 'none', reason: 'noModels', skipped }
  if (input.location === 'cloud' && !input.cloudReady) {
    return { kind: 'none', reason: 'cloudNotConfigured', skipped: entries.map(entry => ({ entry, block: { usable: false, reason: 'cloudNotConfigured' } })) }
  }
  for (const entry of entries) {
    const credential = input.credential(entry)
    if (!credential.usable) { skipped.push({ entry, block: credential }); continue }
    if (input.location === 'cloud') return { kind: 'cloud', entry, model: entry.model, skipped }
    const eligible = input.devices.flatMap(device => {
      const model = deviceModel(device, entry)
      return model ? [{ device, model }] : []
    })
    if (!eligible.length) { skipped.push({ entry, block: { usable: false, reason: 'noDevice' } }); continue }
    const pick = pickDevice(eligible)!
    return { kind: 'device', entry, deviceId: pick.device.id, model: pick.model, skipped }
  }
  const reason: NothingReason = skipped.some(item => item.block.reason === 'noDevice') ? 'noDevice' : 'unavailable'
  return { kind: 'none', reason, skipped }
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
export function defaultOrder(all: readonly OrderCandidate[], preferred: OrderHarness = 'claude_code'): OrderCandidate[] {
  const candidates = onPreferredAgent(all, preferred)
  const bySource = (items: readonly OrderCandidate[]) => [...items.filter(item => item.source.kind === 'subscription'), ...items.filter(item => item.source.kind !== 'subscription')]
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
