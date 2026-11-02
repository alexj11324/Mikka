import { LOCAL_RECONNECT, LOCAL_TARGET, type SshInstallState } from '@mikka/protocol/bridge'
import type { DeviceView } from '@/app/actions/agents'

/** The four steps Figma V09c-3 shows, over the installer's five (#491). */
export const STEPS = ['connect', 'install', 'start', 'online'] as const
export type Step = (typeof STEPS)[number]
const STEP_OF: Record<SshInstallState['step'], Step> = { login: 'connect', check: 'connect', install: 'install', service: 'start', connect: 'online' }

export type StepState = 'done' | 'running' | 'failed' | 'pending'

/** 添加这台电脑 and its 重新连接 run here, so there is nothing to connect to: the steps start at 安装 / 启动. */
export function isLocal(state: Pick<SshInstallState, 'target'>): boolean {
  return state.target === LOCAL_TARGET || state.target === LOCAL_RECONNECT
}

/** The steps a state shows: all four over SSH; on this computer from 安装 on, and 重新连接 from 启动 on. */
export function visibleSteps(state: Pick<SshInstallState, 'target'>): readonly Step[] {
  if (state.target === LOCAL_RECONNECT) return ['start', 'online']
  if (state.target === LOCAL_TARGET) return ['install', 'start', 'online']
  return STEPS
}

export function stepStates(state: SshInstallState): Record<Step, StepState> {
  // On this computer the node check belongs to installing; there is no connection step.
  const current = STEPS.indexOf(isLocal(state) && state.step === 'check' ? 'install' : STEP_OF[state.step])
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
