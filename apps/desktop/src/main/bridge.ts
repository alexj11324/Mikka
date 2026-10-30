// The IPC surface the preload exposes. Main trusts only the app's main frame
// and validates every payload inside the handler it calls.

import { webContents, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { LocalDevice } from '@mikka/protocol/bridge'
import { IPC } from '@mikka/protocol/ipc'
import type { QuotaSnapshotReport } from '@mikka/protocol/quota'

import type { NotificationCenter } from './notification-center'
import { SshInstaller } from './ssh-install'
import { isTrustedFrame } from './security'

export interface BridgeOptions {
  appUrl: string
  mintEnrollment(): Promise<string>
  openExternal(url: string): Promise<void>
  prepareAuth(state: string): Promise<string>
  localDevice(): Promise<LocalDevice>
  quota(): Promise<QuotaSnapshotReport>
  notifications: NotificationCenter
  consumePendingClick(): string | null
}

export function registerBridge(options: BridgeOptions, sshInstaller?: SshInstaller): void {
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

  const installer = sshInstaller ?? new SshInstaller(options.appUrl, options.mintEnrollment, state => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), options.appUrl)) contents.send(IPC.sshChanged, state)
    }
  })
  handle(IPC.sshHosts, () => installer.hosts())
  handle(IPC.sshState, () => installer.state())
  handle(IPC.sshBegin, target => {
    if (typeof target !== 'string' || target.length > 300) throw new Error('Invalid SSH host')
    return installer.begin(target)
  })
  handle(IPC.sshCancel, id => {
    if (typeof id !== 'string') throw new Error('Invalid installation id')
    return installer.cancel(id)
  })
  handle(IPC.sshAccept, id => {
    if (typeof id !== 'string') throw new Error('Invalid installation id')
    return installer.accept(id)
  })
  handle(IPC.appOpenExternal, url => options.openExternal(typeof url === 'string' ? url : ''))
  handle(IPC.appPrepareAuth, state => options.prepareAuth(typeof state === 'string' ? state : ''))
  handle(IPC.deviceStatus, () => options.localDevice())
  handle(IPC.quotaGet, () => options.quota())
  handle(IPC.notificationsShow, notification => options.notifications.show(notification))
  handle(IPC.notificationsSetBadge, count => options.notifications.setBadge(count))
  handle(IPC.notificationsConsumePendingClick, () => options.consumePendingClick())
}
