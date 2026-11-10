// The only surface the renderer gets. It is exposed only on the app's own
// origin and never forwards `ipcRenderer`, `require` or a Node object.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { MikkaBridge, SshInstallState, BundledBridge, BundledLiveEvent, BundledViewerEvent } from '@mikka/protocol/bridge'
import { IPC, BUNDLED_IPC } from '@mikka/protocol/ipc'

const prefix = '--mikka-app-origin='
const appOrigin = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)

function onNotificationClick(listener: (href: string) => void): () => void {
  const handler = (_event: IpcRendererEvent, href: string) => listener(href)
  ipcRenderer.on(IPC.notificationsClicked, handler)
  return () => { ipcRenderer.removeListener(IPC.notificationsClicked, handler) }
}

const localOrigin = `${window.location.protocol}//${window.location.host}`
const bundled = appOrigin === 'mikka://app'
let decodedPath = ''
try { decodedPath = decodeURIComponent(window.location.pathname) } catch { /* Malformed paths never get native privileges. */ }
const localPage = (decodedPath === '/mikka' || decodedPath.startsWith('/mikka/')) && !/^\/mikka\/(?:api|assets)(?:\/|$)/.test(decodedPath)
if (appOrigin && window.top === window && (bundled ? localOrigin === appOrigin && localPage : window.location.origin === appOrigin)) {
  // Lets the page reserve room for the macOS traffic lights and draw its own drag region.
  // The preload runs before <html> exists, so wait for the document.
  // A translucent window (macOS vibrancy) also marks the page, so only its rail and list go see-through.
  if (process.argv.includes('--mikka-1512-read-diagnostic')) {
    try { contextBridge.exposeInMainWorld('__mikka1512ReadDiagnosticEnabled', true) } catch { /* absent diagnostics remain incomplete */ }
  }
  const translucent = process.argv.includes('--mikka-translucent')
  const markPlatform = () => {
    document.documentElement.dataset.desktopPlatform = process.platform
    if (translucent) document.documentElement.dataset.desktopTranslucent = ''
  }
  if (document.documentElement) markPlatform()
  else window.addEventListener('DOMContentLoaded', markPlatform, { once: true })

  const bridge = {
    app: {
      version: __MIKKA_APP_VERSION__,
      flavor: __MIKKA_FLAVOR__,
      runtime: 'electron',
      // The current account's server (#1557), read once: switching servers reloads the page.
      serverUrl: bundled ? String(ipcRenderer.sendSync(BUNDLED_IPC.serverUrl) || __MIKKA_APP_URL__) : __MIKKA_APP_URL__,
      zeroUrl: '',
      openExternal: (url: unknown) => ipcRenderer.invoke(IPC.appOpenExternal, url),
      prepareAuth: (state: unknown) => ipcRenderer.invoke(IPC.appPrepareAuth, state),
      prepareReturn: (state: unknown) => ipcRenderer.invoke(IPC.appPrepareReturn, state),
      onReturn: (listener: (event: { state: string; result: 'connected' | 'failed' | 'cancelled' }) => void) => {
        const handler = (_event: IpcRendererEvent, returned: { state: string; result: 'connected' | 'failed' | 'cancelled' }) => listener(returned)
        ipcRenderer.on(IPC.appReturned, handler)
        return () => { ipcRenderer.removeListener(IPC.appReturned, handler) }
      },
      claudeCallback: (authorizationUrl: unknown) => ipcRenderer.invoke(IPC.appClaudeCallback, authorizationUrl),
      updateReady: () => ipcRenderer.invoke(IPC.appUpdateReady),
      onUpdateReady: (listener: (version: string) => void) => {
        const handler = (_event: IpcRendererEvent, version: string) => listener(version)
        ipcRenderer.on(IPC.appUpdateReady, handler)
        return () => { ipcRenderer.removeListener(IPC.appUpdateReady, handler) }
      },
      installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
      requireUpdate: () => ipcRenderer.invoke(IPC.appRequireUpdate),
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
      local: () => ipcRenderer.invoke(IPC.sshLocal),
      restartLocal: () => ipcRenderer.invoke(IPC.sshRestartLocal),
      autoLocal: (action: unknown) => ipcRenderer.invoke(IPC.sshAutoLocal, action),
    },
    device: {
      status: () => ipcRenderer.invoke(IPC.deviceStatus),
      pickRepo: () => ipcRenderer.invoke(IPC.devicePickRepo),
    },
    quota: {
      get: () => ipcRenderer.invoke(IPC.quotaGet),
    },
  }
  const bundledBridge: BundledBridge = {
    session: () => ipcRenderer.invoke(BUNDLED_IPC.session),
    signIn: input => ipcRenderer.invoke(BUNDLED_IPC.signIn, input),
    signInEmail: input => ipcRenderer.invoke(BUNDLED_IPC.signInEmail, input),
    signOut: () => ipcRenderer.invoke(BUNDLED_IPC.signOut),
    accounts: () => ipcRenderer.invoke(BUNDLED_IPC.accounts),
    linkAccount: provider => ipcRenderer.invoke(BUNDLED_IPC.linkAccount, provider),
    server: {
      state: () => ipcRenderer.invoke(BUNDLED_IPC.serverState),
      probe: address => ipcRenderer.invoke(BUNDLED_IPC.serverProbe, address),
      select: url => ipcRenderer.invoke(BUNDLED_IPC.serverSelect, url),
      disconnect: url => ipcRenderer.invoke(BUNDLED_IPC.serverDisconnect, url),
    },
    onSessionChanged: listener => {
      const handler = () => listener()
      ipcRenderer.on(BUNDLED_IPC.sessionChanged, handler)
      return () => { ipcRenderer.removeListener(BUNDLED_IPC.sessionChanged, handler) }
    },
    live: {
      prepare: workspace => ipcRenderer.invoke(BUNDLED_IPC.livePrepare, workspace),
      connect: id => ipcRenderer.invoke(BUNDLED_IPC.liveConnect, id),
      send: (id, data) => ipcRenderer.invoke(BUNDLED_IPC.liveSend, id, data),
      close: id => ipcRenderer.invoke(BUNDLED_IPC.liveClose, id),
      onEvent: listener => {
        const handler = (_event: IpcRendererEvent, event: BundledLiveEvent) => listener(event)
        ipcRenderer.on(BUNDLED_IPC.liveEvent, handler)
        return () => { ipcRenderer.removeListener(BUNDLED_IPC.liveEvent, handler) }
      },
    },
    viewer: {
      prepare: input => ipcRenderer.invoke(BUNDLED_IPC.viewerPrepare, input),
      connect: id => ipcRenderer.invoke(BUNDLED_IPC.viewerConnect, id),
      send: (id, data) => ipcRenderer.invoke(BUNDLED_IPC.viewerSend, id, data),
      close: id => ipcRenderer.invoke(BUNDLED_IPC.viewerClose, id),
      onEvent: listener => {
        const handler = (_event: IpcRendererEvent, event: BundledViewerEvent) => listener(event)
        ipcRenderer.on(BUNDLED_IPC.viewerEvent, handler)
        return () => { ipcRenderer.removeListener(BUNDLED_IPC.viewerEvent, handler) }
      },
    },
  }
  contextBridge.exposeInMainWorld('mikka', { ...bridge, ...(bundled ? { bundled: bundledBridge } : {}) } as unknown as MikkaBridge)
}
