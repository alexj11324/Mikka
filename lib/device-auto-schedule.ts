/**
 * 「允许自动调度」 (decision 2026-10-31-2200-run-machine-fallback): whether Mikka
 * may pick this device on its own. A device the person names is used anyway.
 * Unset means the type default: on for servers, off for personal computers.
 */
export function autoScheduleOn(device: { autoSchedule?: boolean | null; deviceType?: string | null }): boolean {
  return device.autoSchedule ?? device.deviceType === 'server'
}
