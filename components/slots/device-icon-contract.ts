/** A machine's state: online, offline, or failed. */
export type DeviceState = 'online' | 'offline' | 'error'

/**
 * The icon for a machine in device pickers (新建任务's device pill and its menu).
 * `label` is the state in words for screen readers; `surface` is what the icon sits on.
 */
export type DeviceIconProps = {
  kind: 'personal' | 'server' | 'cloud'
  state: DeviceState
  label: string
  surface?: 'popover' | 'muted'
}
