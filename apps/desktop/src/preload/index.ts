// The only surface the renderer gets. It is exposed only on the app's own
// origin and never forwards `ipcRenderer`, `require` or a Node object.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { MikkaBridge } from '@mikka/protocol/bridge'
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
  document.documentElement.dataset.desktopPlatform = process.platform

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
