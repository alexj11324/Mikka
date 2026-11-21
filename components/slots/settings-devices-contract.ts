// What 设置 › 设备's page receives (docs/ui-overlay.md). Reading, live updates,
// the add / reconnect dialogs and the desktop bridge stay in DevicesSettings.
import type { ReactNode } from 'react'
import type { DeviceView } from '@/app/actions/agents'

export type SettingsDevicesProps = {
  /** Only the latest successful read can supply actionable device rows. */
  devices: DeviceView[] | undefined
  /** The latest read failed. Retry through onChanged. */
  listError: boolean
  /** Opens 添加设备 (also ⌘N). */
  onAdd: () => void
  /** Re-reads the list after a change or a failed read. */
  onChanged: () => void
  /** 重新连接 on an offline device. */
  onReconnect: (device: DeviceView) => void
  /** This computer's setup state in the desktop app; null elsewhere. */
  localSetup: ReactNode
}
