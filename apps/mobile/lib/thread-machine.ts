/**
 * Where a thread runs, as GET /api/mobile/threads/:id/machine returns it (the web's lib/thread-machine.ts),
 * and the lines its popover shows: a name, a state and the facts that tell the machine apart.
 */
export type ThreadMachineKind = 'cloud' | 'laptop' | 'server'
export type ThreadMachineState = 'online' | 'offline' | 'starting' | 'running' | 'paused' | 'ended' | 'error'
export interface ThreadMachine {
  kind: ThreadMachineKind
  state: ThreadMachineState
  name: string | null
  platform: string | null
  arch: string | null
  hostname: string | null
  lastSeenAt: string | null
  cloud: { sandboxId: string; template: string; createdAt: string; endedAt: string | null } | null
}

const STATE: Record<ThreadMachineState, string> = { online: '在线', offline: '离线', starting: '启动中', running: '运行中', paused: '休眠', ended: '已停止', error: '出错' }
/** The SF Symbol for each kind (Symbol.ios.tsx). */
export const MACHINE_SYMBOL = { cloud: 'cloud', laptop: 'laptopcomputer', server: 'server.rack' } as const

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
function ago(value: string, now: number) {
  const minutes = Math.max(1, Math.round((now - new Date(value).getTime()) / 60_000))
  return minutes < 60 ? `${minutes} 分钟前` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 1440)} 天前`
}

export function machineLines(machine: ThreadMachine, now = Date.now()) {
  const name = machine.kind === 'cloud'
    ? machine.cloud ? `云电脑 ${machine.cloud.sandboxId.slice(0, 6)}` : '云电脑'
    : machine.name || (machine.kind === 'server' ? '服务器' : '电脑')
  const os = machine.platform === 'darwin' ? 'macOS' : machine.platform === 'win32' ? 'Windows' : machine.platform === 'linux' ? 'Linux' : machine.platform
  const system = [os, machine.arch].filter(Boolean).join(' · ')
  const rows: [string, string][] = []
  if (machine.cloud) {
    rows.push(['ID', machine.cloud.sandboxId])
    if (machine.cloud.template) rows.push(['模板', machine.cloud.template])
    rows.push(['创建', time(machine.cloud.createdAt)])
    if (machine.cloud.endedAt) rows.push(['停止', time(machine.cloud.endedAt)])
  }
  if (system) rows.push(['系统', system])
  if (machine.hostname) rows.push(['主机', machine.hostname])
  if (machine.state === 'offline' && machine.lastSeenAt) rows.push(['上次在线', ago(machine.lastSeenAt, now)])
  const live = machine.state === 'online' || machine.state === 'running' || machine.state === 'starting'
  return { name, state: STATE[machine.state], live, failed: machine.state === 'error', rows }
}
