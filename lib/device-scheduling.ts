import { deviceStage, deviceSupport, pickDevice, planDispatch, whyNoDevice, type CredentialState, type OrderEntry, type PoolDevice, type RunLocation } from './model-order-plan'
import type { CloudModelState } from './cloud-template-models'

export type PresenceReason = 'online' | 'never_seen' | 'future_heartbeat' | 'heartbeat_expired'
export function devicePresenceView(lastSeenAt: Date | string | number | null | undefined, online: boolean, now = Date.now()): { presenceReason: PresenceReason; offlineDays: number | null } {
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : typeof lastSeenAt === 'number' ? lastSeenAt : Date.parse(lastSeenAt ?? '')
  if (seen > now) return { presenceReason: 'future_heartbeat', offlineDays: null }
  if (online) return { presenceReason: 'online', offlineDays: 0 }
  if (!Number.isFinite(seen)) return { presenceReason: 'never_seen', offlineDays: null }
  return { presenceReason: 'heartbeat_expired', offlineDays: Math.floor((now - seen) / 86_400_000) }
}

export interface SchedulingNode {
  id: string
  type: 'cloud' | 'server' | 'laptop'
  name: string
  /** Only available nodes get a dispatch rank. Unavailable/excluded nodes remain explainable. */
  order: number | null
  availability: 'ready' | 'unavailable' | 'excluded'
  reason: string
  excluded: boolean
  offlineDays: number | null
  presenceReason: PresenceReason | null
  harnesses: { harness: string; installed: boolean; models: string[] }[]
  models: { id: string; harness: string; available: boolean; reason: string; modelEvidence?: 'account_catalogue' | 'cli_report' | 'only_latest_confirmed' | 'unknown' }[]
}

type Device = PoolDevice & { lastSeenAt?: Date | string | number | null }
/** Uses the dispatch planner repeatedly, so model preference and device load cannot drift from the read view. */
export function deviceSchedulingView(input: {
  location: RunLocation; entries: readonly OrderEntry[]; devices: readonly Device[]
  credential: (entry: OrderEntry) => CredentialState; cloudReady: boolean; cloudModel: (entry: OrderEntry) => CloudModelState; now?: number
}): SchedulingNode[] {
  const now = input.now ?? Date.now()
  const devices = input.devices.map(device => ({ ...device, online: device.online && devicePresenceView(device.lastSeenAt, device.online, now).presenceReason !== 'future_heartbeat' }))
  const ready: string[] = []
  let cloudReady = input.cloudReady
  let remaining = [...devices]
  for (let count = 0; count <= devices.length; count++) {
    const plan = planDispatch({ ...input, devices: remaining, cloudReady })
    if (plan.kind === 'none') break
    if (plan.kind === 'cloud') { ready.push('cloud'); cloudReady = false }
    else { ready.push(plan.deviceId); remaining = remaining.filter(device => device.id !== plan.deviceId) }
  }
  const nodes: SchedulingNode[] = []
  if (input.location === 'cloud') {
    const cloudPlan = planDispatch({ ...input, devices: [], location: 'cloudOnly' })
    const available = cloudPlan.kind === 'cloud'
    nodes.push({ id: 'cloud', type: 'cloud', name: 'Mikka Cloud', order: null, availability: available ? 'ready' : 'unavailable',
      reason: available ? 'ready' : cloudPlan.kind === 'none' ? cloudPlan.reason : 'cloudNotConfigured', excluded: false, offlineDays: null, presenceReason: null,
      harnesses: [...new Set(input.entries.map(entry => entry.harness))].map(harness => ({ harness, installed: true,
        models: [...new Set(input.entries.filter(entry => entry.harness === harness && input.cloudModel(entry) === 'ready').map(entry => entry.model))] })),
      models: input.entries.map(entry => { const state = input.credential(entry); const support = input.cloudModel(entry); return { id: entry.model, harness: entry.harness,
        available: input.cloudReady && state.usable && support === 'ready', reason: !state.usable ? state.reason : !input.cloudReady ? 'cloudNotConfigured' : support } }),
    })
  }
  // Stable descriptive order for nodes which dispatch cannot use right now.
  const unsorted = devices.map(device => ({ device }))
  while (unsorted.length) {
    const { device } = pickDevice(unsorted)!
    unsorted.splice(unsorted.findIndex(item => item.device.id === device.id), 1)
    const presence = devicePresenceView(device.lastSeenAt, device.online, now)
    const plan = planDispatch({ ...input, devices: [device], location: 'local', cloudReady: false })
    const available = plan.kind === 'device'
    const runnable = input.entries.filter(entry => input.credential(entry).usable)
    const reason = !device.enabled ? 'off' : presence.presenceReason === 'future_heartbeat' ? 'future_heartbeat' : !device.online ? 'offline'
      : available ? 'ready' : plan.kind === 'none' && plan.reason !== 'noDevice' ? plan.reason : runnable.length ? whyNoDevice([device], runnable[0]).why : 'unavailable'
    nodes.push({ id: device.id, type: device.server ? 'server' : 'laptop', name: device.name, order: null,
      availability: !device.enabled ? 'excluded' : available ? 'ready' : 'unavailable', reason, excluded: !device.enabled, ...presence,
      harnesses: device.harnesses.map(info => ({ harness: info.harness, installed: info.installed,
        models: [...new Set(input.entries.filter(entry => entry.harness === info.harness && deviceSupport(device, entry) === 'ready').map(entry => entry.model))] })),
      models: input.entries.map(entry => { const state = input.credential(entry); const stage = deviceStage(device, entry); return { id: entry.model, harness: entry.harness,
        available: state.usable && stage === 'ready', reason: stage !== 'ready' ? stage : !state.usable ? state.reason : 'ready' } }),
    })
  }
  for (const node of nodes) { const rank = ready.indexOf(node.id); node.order = rank < 0 ? null : rank + 1 }
  return nodes.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
}
