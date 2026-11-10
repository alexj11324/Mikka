// The IPC surface the preload exposes. Main trusts only the app's main frame
// and validates every payload inside the handler it calls.

import { webContents, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { LocalDevice, LocalDeviceAccount } from '@mikka/protocol/bridge'
import type { ComputerDoctor } from '@mikka/protocol/computer'
import { IPC } from '@mikka/protocol/ipc'
import type { QuotaSnapshotReport } from '@mikka/protocol/quota'

import type { NotificationCenter } from './notification-center'
import { SshInstaller } from './ssh-install'
import type { Updates } from './updates'
import { isTrustedFrame, trustedIpcSender } from './security'
import { localSetupController } from './local-setup'

export interface BridgeOptions {
  appUrl: string
  /** The current account's server (#1557); the daemon installed here registers with it. */
  serverUrl?: () => string
  rendererUrl?: string
  /** The desktop's flavor: 添加这台电脑 installs the matching daemon. */
  flavor?: 'prod' | 'dev'
  mintEnrollment(): Promise<string>
  openExternal(url: string): Promise<void>
  prepareAuth(state: string): Promise<string>
  prepareReturn(state: string): Promise<string>
  claudeCallback(authorizationUrl: unknown): Promise<string | null>
  localDevice(): Promise<LocalDevice>
  /** Local computer use on this Mac; null when no daemon answers. */
  computerPermissions(): Promise<ComputerDoctor | null>
  /** The person's click: requests macOS grants for the local driver, then reports. */
  grantComputerPermissions(): Promise<ComputerDoctor | null>
  pickRepo?(): Promise<import('@mikka/protocol/bridge').PickRepoResult>
  localAccount(): Promise<LocalDeviceAccount>
  localOwner(): Promise<Pick<LocalDeviceAccount, 'ownerId'>>
  quota(): Promise<QuotaSnapshotReport>
  notifications: NotificationCenter
  consumePendingClick(): string | null
  updates: Pick<Updates, 'ready' | 'install'>
  /** The page saw a minimum desktop version above this build; main checks the server itself. */
  requireUpdate(): Promise<void>
}

export function registerBridge(options: BridgeOptions, sshInstaller?: SshInstaller): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    return trustedIpcSender(frame, options.rendererUrl ?? options.appUrl)
  }

  function handle(channel: string, run: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('untrusted IPC sender')
      return run(...args)
    })
  }

  const installer = sshInstaller ?? new SshInstaller(options.serverUrl ?? options.appUrl, options.mintEnrollment, state => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), options.rendererUrl ?? options.appUrl)) contents.send(IPC.sshChanged, state)
    }
  }, undefined, undefined, undefined, undefined, options.flavor, undefined, async (deviceId, ownerId) => {
    const current = await options.localAccount()
    if (current.ownerId !== ownerId) throw new Error('Signed-in account changed')
    return current.deviceIds.includes(deviceId)
  })
  const local = localSetupController(installer, options.localOwner)
  handle(IPC.sshHosts, () => installer.hosts())
  handle(IPC.sshState, () => installer.state())
  handle(IPC.sshLocal, () => local.install())
  // The authenticated account is read in main; a workspace is not an identity.
  handle(IPC.sshAutoLocal, action => {
    if (action !== 'install' && action !== 'repair') throw new Error('Invalid setup')
    return local.automatic(action)
  })
  handle(IPC.sshRestartLocal, () => local.restart())
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
  handle(IPC.appPrepareReturn, state => options.prepareReturn(typeof state === 'string' ? state : ''))
  handle(IPC.appClaudeCallback, url => options.claudeCallback(url))
  handle(IPC.appUpdateReady, () => options.updates.ready)
  handle(IPC.appInstallUpdate, () => options.updates.install())
  handle(IPC.appRequireUpdate, () => options.requireUpdate())
  handle(IPC.deviceStatus, () => options.localDevice())
  handle(IPC.devicePickRepo, () => options.pickRepo?.() ?? { status: 'cancelled' })
  handle(IPC.deviceComputerPermissions, () => options.computerPermissions())
  handle(IPC.deviceComputerPermissionsGrant, () => options.grantComputerPermissions())
  handle(IPC.quotaGet, () => options.quota())
  handle(IPC.notificationsShow, notification => options.notifications.show(notification))
  handle(IPC.notificationsSetBadge, count => options.notifications.setBadge(count))
  handle(IPC.notificationsConsumePendingClick, () => options.consumePendingClick())
}
