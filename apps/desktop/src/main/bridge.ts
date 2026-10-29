// The IPC surface the preload exposes. Main trusts only the app's main frame
// and validates every payload inside the handler it calls.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { LocalDevice } from '@mikka/protocol/bridge'
import { IPC } from '@mikka/protocol/ipc'
import type { QuotaSnapshotReport } from '@mikka/protocol/quota'

import type { NotificationCenter } from './notification-center'
import { isTrustedFrame } from './security'

export interface BridgeOptions {
  appUrl: string
  localDevice(): Promise<LocalDevice>
  quota(): Promise<QuotaSnapshotReport>
  notifications: NotificationCenter
  consumePendingClick(): string | null
}

export function registerBridge(options: BridgeOptions): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    return frame !== null && frame.parent === null && isTrustedFrame(frame.url, options.appUrl)
  }

  function handle(channel: string, run: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('untrusted IPC sender')
      return run(...args)
    })
  }

  handle(IPC.deviceStatus, () => options.localDevice())
  handle(IPC.quotaGet, () => options.quota())
  handle(IPC.notificationsShow, notification => options.notifications.show(notification))
  handle(IPC.notificationsSetBadge, count => options.notifications.setBadge(count))
  handle(IPC.notificationsConsumePendingClick, () => options.consumePendingClick())
}
