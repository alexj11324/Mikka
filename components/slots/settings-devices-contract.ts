// What 设置 › 设备's page receives (docs/ui-overlay.md). Reading, live updates,
// the add / reconnect dialogs and the desktop bridge stay in DevicesSettings.
import type { ReactNode } from 'react'
import type { DeviceView } from '@/app/actions/agents'

export type SettingsDevicesProps = {
  /** Undefined until the first read answers. */
  devices: DeviceView[] | undefined
  /** The latest read failed; earlier devices, if any, are still shown. */
  listError: boolean
  /** Opens 添加设备 (also ⌘N). */
  onAdd: () => void
  /** Re-reads the list after an action. */
  onChanged: () => void
  /** 重新连接 on an offline device. */
  onReconnect: (device: DeviceView) => void
  /** This computer's setup state in the desktop app; null elsewhere. */
  localSetup: ReactNode
}
