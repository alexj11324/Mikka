/** The app's thread states (docs/design/mobile.md, 线程 screen icons). */
export type MobileThreadStatus = 'running' | 'waiting' | 'paused' | 'failed' | 'done' | 'stopped'

/** A run's status as the app shows it; a run paused on its quota is 已暂停, not 运行中. */
export function mobileThreadStatus(status: string): MobileThreadStatus {
  switch (status) {
    case 'waiting_input': return 'waiting'
    case 'paused': return 'paused'
    case 'failed': return 'failed'
    case 'succeeded': return 'done'
    case 'stopped': case 'cancelled': return 'stopped'
    default: return 'running'
  }
}
