import type { SshInstallState } from '@mikka/protocol/bridge'
import type { DeviceView } from '@/app/actions/agents'

/** The four steps Figma V09c-3 shows, over the installer's five (#491). */
export const STEPS = ['connect', 'install', 'start', 'online'] as const
export type Step = (typeof STEPS)[number]
const STEP_OF: Record<SshInstallState['step'], Step> = { login: 'connect', check: 'connect', install: 'install', service: 'start', connect: 'online' }

export type StepState = 'done' | 'running' | 'failed' | 'pending'

export function stepStates(state: SshInstallState): Record<Step, StepState> {
  const current = STEPS.indexOf(STEP_OF[state.step])
  return Object.fromEntries(STEPS.map((step, index) => {
    if (state.status === 'online') return [step, 'done']
    if (index < current) return [step, 'done']
    if (index > current) return [step, 'pending']
    return [step, state.status === 'failed' ? 'failed' : 'running']
  })) as Record<Step, StepState>
}

/** Whether an `~/.ssh/config` alias already has a device: the daemon registers under the host's name. */
export function addedHost(alias: string, devices: readonly Pick<DeviceView, 'name' | 'hostname'>[]): boolean {
  const name = alias.toLowerCase()
  return devices.some(device => device.name.toLowerCase() === name || device.hostname?.toLowerCase() === name || device.hostname?.toLowerCase().split('.')[0] === name)
}
