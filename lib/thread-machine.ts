/**
 * Where a thread runs, as its header draws it: an icon for the kind, a status
 * dot, and on hover which machine it is (docs/design/thread-run-location.md).
 * Shared by the server read and the browser; nothing here touches the database.
 */
export type ThreadMachineKind = 'cloud' | 'laptop' | 'server'

/** online/offline for a computer or server; the E2B sandbox's own state for a cloud machine. */
export type ThreadMachineState = 'online' | 'offline' | 'starting' | 'running' | 'paused' | 'ended' | 'error'

export interface ThreadMachine {
  kind: ThreadMachineKind
  state: ThreadMachineState
  /** The device's name; null for a cloud machine, which is named by its sandbox. */
  name: string | null
  platform: string | null
  arch: string | null
  hostname: string | null
  lastSeenAt: string | null
  /** Only for a cloud machine. */
  cloud: { sandboxId: string; template: string; createdAt: string; endedAt: string | null } | null
}

/** How many characters of the sandbox ID name a cloud machine: enough to tell two apart in one person's list. */
export const CLOUD_SHORT_ID_LENGTH = 6

export function cloudShortId(sandboxId: string): string {
  return sandboxId.slice(0, CLOUD_SHORT_ID_LENGTH)
}

/** A device row's kind: a cloud row is cloud; a server is what its daemon reported, else a desktop OS is a laptop. */
export function deviceMachineKind(device: { kind: string | null; deviceType: string | null; platform: string | null }): ThreadMachineKind {
  if (device.kind === 'cloud') return 'cloud'
  if (device.deviceType === 'server') return 'server'
  if (device.platform === 'darwin' || device.platform === 'win32') return 'laptop'
  return device.platform ? 'server' : 'laptop'
}

const CLOUD_STATES = new Set<ThreadMachineState>(['starting', 'running', 'paused', 'ended', 'error'])

/** An ended DB write fences new work before provider cleanup. Until its
 * resource references are cleared, use the existing error state rather than
 * presenting an unacknowledged retirement as complete. */
export function cloudMachineState(state: string, resources?: { sandboxId?: string | null; workerLeaseId?: string | null; workerLeaseUntil?: Date | string | null }): ThreadMachineState {
  if (state === 'ended' && (resources?.sandboxId || resources?.workerLeaseId || resources?.workerLeaseUntil)) return 'error'
  return CLOUD_STATES.has(state as ThreadMachineState) ? state as ThreadMachineState : 'error'
}

/**
 * The word for a machine's state: a computer or server whose daemon has never reported in is 「从未上线」, as
 * 设备 says it (Devices.neverOnline), not 离线; every other state is its own (ThreadRunPlace.states.*).
 */
export function machineStateWord(machine: Pick<ThreadMachine, 'kind' | 'state' | 'lastSeenAt'>): ThreadMachineState | 'never' {
  return machine.kind !== 'cloud' && machine.state === 'offline' && !machine.lastSeenAt ? 'never' : machine.state
}

/** The dot on the icon (R-24): green while it can work, red on error, grey otherwise. */
export function machineDot(state: ThreadMachineState): 'running' | 'failed' | 'idle' {
  if (state === 'online' || state === 'running' || state === 'starting') return 'running'
  if (state === 'error') return 'failed'
  return 'idle'
}

/** 「macOS · arm64」 from the daemon's platform and arch; null when neither was reported. */
export function systemLabel(platform: string | null, arch: string | null): string | null {
  const os = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform
  return [os, arch].filter(Boolean).join(' · ') || null
}
