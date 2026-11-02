/**
 * 模型与订阅 › 允许使用的模型 (decision 2026-11-02-1400): which allowed model a new
 * run takes, and where. Pure: the server reads the list, the credentials and
 * the devices (lib/model-order.ts) and asks this module; nothing here reads a
 * database or names a model.
 *
 * Each entry is an Agent and a model from one credential (a connected
 * subscription or an API key). A run takes the first entry that can run now:
 * its credential is usable (connected, not paused, quota left, the key not
 * refused), and the run location has a place for it. 本地: a device whose
 * 参与调度 is on, online, with the Agent installed and, for a subscription
 * model, the model among what its CLI reported; one is picked at random. 云端:
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
  online: boolean
  /** 参与调度: off means Mikka never sends a run here. */
  enabled: boolean
  harnesses: readonly Pick<HarnessInfo, 'harness' | 'installed' | 'models' | 'modelSlots'>[]
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
 * offline, the Agent not installed, or (for a subscription model) the CLI did
 * not report it. An API key's model runs on any installed Agent of the key's
 * protocol, since the key is handed to the run.
 */
export function deviceModel(device: PoolDevice, entry: OrderEntry): string | null {
  if (!device.enabled || !device.online) return null
  const info = device.harnesses.find(item => item.harness === entry.harness && item.installed)
  if (!info) return null
  if (entry.source.kind === 'api_key') return entry.model
  const slot = info.modelSlots?.find(item => item.slot === entry.model || item.model === entry.model)
  if (slot) return slot.slot
  return info.models?.includes(entry.model) ? entry.model : null
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
  random?: () => number
}): DispatchPlan {
  const random = input.random ?? Math.random
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
    const pick = eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))]
    return { kind: 'device', entry, deviceId: pick.device.id, model: pick.model, skipped }
  }
  const reason: NothingReason = skipped.some(item => item.block.reason === 'noDevice') ? 'noDevice' : 'unavailable'
  return { kind: 'none', reason, skipped }
}

/**
 * The only model words written in code (decision 2026-11-02-1400, Alex): how an
 * untouched list is filled from what the person actually has. They match
 * reported model ids and names; a model nothing reported is never added.
 * Claude Code's opus first, then Codex's strongest reasoning tier.
 */
export const DEFAULT_ORDER_PREFERENCE: readonly { harness: OrderHarness; words: readonly string[] }[] = [
  { harness: 'claude_code', words: ['opus'] },
  { harness: 'codex', words: ['xhigh', 'extra high'] },
]

export interface OrderCandidate { harness: OrderHarness; model: string; name: string; source: EntrySource }

/**
 * The list a person who has not touched it gets: for each preference, the
 * first candidate of a subscription (never an API key, which bills per token)
 * whose id or name holds one of its words. A preference nothing matches is
 * skipped: no Claude subscription starts from Codex, no Codex leaves Claude only.
 */
export function defaultOrder(candidates: readonly OrderCandidate[]): OrderCandidate[] {
  const picked: OrderCandidate[] = []
  for (const preference of DEFAULT_ORDER_PREFERENCE) {
    const match = candidates.find(candidate => candidate.source.kind === 'subscription' && candidate.harness === preference.harness
      && preference.words.some(word => `${candidate.model} ${candidate.name}`.toLowerCase().includes(word)))
    if (match) picked.push(match)
  }
  return picked
}

/** The same Agent, model and credential: one entry. */
export const entryKey = (entry: Pick<OrderEntry, 'harness' | 'model' | 'source'>) =>
  `${entry.harness}\u0000${entry.model}\u0000${entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId}`
