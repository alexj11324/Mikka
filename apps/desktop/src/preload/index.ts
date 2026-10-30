// The only surface the renderer gets. It is exposed only on the app's own
// origin and never forwards `ipcRenderer`, `require` or a Node object.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { MikkaBridge, SshInstallState } from '@mikka/protocol/bridge'
import { IPC } from '@mikka/protocol/ipc'

const prefix = '--mikka-app-origin='
const appOrigin = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)

function onNotificationClick(listener: (href: string) => void): () => void {
  const handler = (_event: IpcRendererEvent, href: string) => listener(href)
  ipcRenderer.on(IPC.notificationsClicked, handler)
  return () => { ipcRenderer.removeListener(IPC.notificationsClicked, handler) }
}

if (appOrigin && window.location.origin === appOrigin) {
  // Lets the page reserve room for the macOS traffic lights and draw its own drag region.
  // The preload runs before <html> exists, so wait for the document.
  const markPlatform = () => { document.documentElement.dataset.desktopPlatform = process.platform }
  if (document.documentElement) markPlatform()
  else window.addEventListener('DOMContentLoaded', markPlatform, { once: true })

  const bridge = {
    app: {
      version: __MIKKA_APP_VERSION__,
      flavor: __MIKKA_FLAVOR__,
      runtime: 'electron',
      serverUrl: __MIKKA_APP_URL__,
      zeroUrl: '',
      openExternal: (url: unknown) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    prepareAuth: (state: unknown) => ipcRenderer.invoke(IPC.appPrepareAuth, state),
    },
    notifications: {
      show: (notification: unknown) => ipcRenderer.invoke(IPC.notificationsShow, notification),
      setBadge: (count: unknown) => ipcRenderer.invoke(IPC.notificationsSetBadge, count),
      onClick: onNotificationClick,
      consumePendingClick: () => ipcRenderer.invoke(IPC.notificationsConsumePendingClick),
    },
    ssh: {
      onChange: (listener: (state: SshInstallState) => void) => {
        const handler = (_event: IpcRendererEvent, state: SshInstallState) => listener(state)
        ipcRenderer.on(IPC.sshChanged, handler)
        return () => { ipcRenderer.removeListener(IPC.sshChanged, handler) }
      },
      hosts: () => ipcRenderer.invoke(IPC.sshHosts),
      begin: (target: unknown) => ipcRenderer.invoke(IPC.sshBegin, target),
      cancel: (id: unknown) => ipcRenderer.invoke(IPC.sshCancel, id),
      accept: (id: unknown) => ipcRenderer.invoke(IPC.sshAccept, id),
      state: () => ipcRenderer.invoke(IPC.sshState),
    },
    device: {
      status: () => ipcRenderer.invoke(IPC.deviceStatus),
    },
    quota: {
      get: () => ipcRenderer.invoke(IPC.quotaGet),
    },
  }
  // v1 implements the native capabilities only; auth and local settings stay
  // in the web session until their server support exists.
  contextBridge.exposeInMainWorld('mikka', bridge as unknown as MikkaBridge)
}
