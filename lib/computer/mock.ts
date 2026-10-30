// i18n-ignore-file: Sample data for the mock backend, standing in for what the real API returns.
import type { ApprovalDecision, ApprovalView, ComputerEvent, ComputerState, KnownHost, SetupStep, SetupStepState, ViewerGrant, ViewerMode } from './types'

/**
 * A stand-in for the cloud computer backend (#172) while it is being built,
 * on when NEXT_PUBLIC_COMPUTER_MOCK=1. It keeps state in the page and plays
 * the same states the real API reports. Like the real one there is one
 * machine per workspace: ?computer-mock=sleep in the page address starts it
 * asleep and ?computer-mock=waking starts it mid-wake (it stays there, for
 * review). The agent id picks the opening state of its desktop: ids
 * containing "approval", "done" or "idle" start there.
 */

export const MOCK_SCREEN_URL = 'mock:desktop'
/** The 登录 button on the mock desktop, in 1280×800 screen coordinates. */
const LOGIN_BUTTON = { x: 504, y: 418, w: 232, h: 40 }

const states = new Map<string, ComputerState>()
let machine: ComputerState['machine'] | null = null
const listeners = new Set<(event: ComputerEvent) => void>()

function emit(event: ComputerEvent) { for (const listener of listeners) listener(event) }

function opening(botId: string): ComputerState {
  const at = new Date().toISOString()
  const click = { tool: 'click' as const, x: LOGIN_BUTTON.x + 170, y: LOGIN_BUTTON.y + 28, rect: LOGIN_BUTTON, at }
  if (botId.includes('idle') || botId.includes('done')) return { machine: 'running', control: 'idle' }
  if (botId.includes('approval')) return {
    machine: 'running', control: 'agent', lastAction: click,
    pendingApproval: { id: `approval-${botId}`, digest: 'mock', runId: `run-${botId}`, botId, action: { tool: 'click', x: click.x, y: click.y, text: 'qa@mikka.dev', rect: LOGIN_BUTTON }, summary: '点击「登录」', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  }
  return { machine: 'running', control: 'agent', lastAction: click }
}

function read(botId: string): ComputerState {
  if (machine === null) {
    const start = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('computer-mock') : null
    machine = start === 'sleep' ? 'sleeping' : start === 'waking' ? 'waking' : 'running'
  }
  let state = states.get(botId)
  if (!state) { state = opening(botId); states.set(botId, state) }
  return { ...state, machine }
}

function write(botId: string, next: ComputerState) { machine = next.machine; states.set(botId, next) }

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const mockComputer = {
  async state(botId: string): Promise<ComputerState> { await pause(80); return { ...read(botId) } },
  async wake(botId: string) {
    write(botId, { ...read(botId), machine: 'waking' })
    emit({ type: 'computer.machine', state: 'waking' })
    setTimeout(() => {
      write(botId, { ...read(botId), machine: 'running' })
      emit({ type: 'computer.machine', state: 'running' })
    }, 3000)
  },
  async viewer(_botId: string, _mode: ViewerMode): Promise<ViewerGrant> {
    return { url: MOCK_SCREEN_URL, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
  },
  async takeover(botId: string, userId: string): Promise<ViewerGrant> {
    write(botId, { ...read(botId), control: 'user', controlledBy: { userId }, lastAction: undefined })
    emit({ type: 'computer.control', botId, control: 'user', controlledBy: { userId } })
    return mockComputer.viewer(botId, 'control')
  },
  async handback(botId: string) {
    write(botId, { ...read(botId), control: 'agent', controlledBy: undefined })
    emit({ type: 'computer.control', botId, control: 'agent' })
  },
  async decide(approval: ApprovalView, decision: ApprovalDecision): Promise<{ queued: true }> {
    await pause(300)
    write(approval.botId, { ...read(approval.botId), pendingApproval: undefined })
    emit({ type: 'computer.approval', botId: approval.botId, approval: null })
    void decision
    return { queued: true }
  },
  subscribe(listener: (event: ComputerEvent) => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

export const MOCK_HOSTS: KnownHost[] = [
  { alias: 'gpu-box', source: 'tailnet', configured: true },
  { alias: 'aws-emr', hostName: 'ec2-3-91-12-4.compute-1.amazonaws.com', user: 'hadoop', source: 'ssh', configured: false },
  { alias: 'build-01', hostName: '10.0.4.21', source: 'ssh', configured: false },
  { alias: 'staging-db', hostName: 'staging-db.internal', source: 'ssh', configured: false },
  { alias: 'mac-mini', hostName: 'mac-mini.local', source: 'ssh', configured: false },
]

/** Plays the five setup steps the SSH install streams, one every ~1.2s. */
export async function mockSetup(onStep: (step: SetupStep, state: SetupStepState) => void, signal: AbortSignal) {
  for (const step of ['login', 'check', 'install', 'start', 'connect'] as const) {
    onStep(step, 'active')
    await pause(step === 'install' ? 2400 : 1200)
    if (signal.aborted) return
    onStep(step, 'done')
  }
}
