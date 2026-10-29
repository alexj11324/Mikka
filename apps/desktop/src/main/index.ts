// Electron main: one window on the shared web UI, plus the native abilities
// the UI reads through `window.mikka`. The renderer is treated as untrusted;
// every privileged call goes through the validated IPC surface in `./bridge`.

import { app, BrowserWindow, Menu, Notification, dialog, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, resolve } from 'node:path'

import { IPC } from '@mikka/protocol/ipc'

import { registerBridge } from './bridge'
import { localDeviceStatus, localQuota } from './daemon'
import { NotificationCenter } from './notification-center'
import { appExternalUrl, desktopAuthFinishUrl, externalUrl, navigationDecision } from './security'

const APP_URL = __MIKKA_APP_URL__
const APP_VERSION = __MIKKA_APP_VERSION__
const FLAVOR = __MIKKA_FLAVOR__
const PARTITION = FLAVOR === 'dev' ? 'persist:mikka-dev' : 'persist:mikka'
const APP_ORIGIN = new URL(APP_URL).origin
const AUTH_PROTOCOL = 'mikka-desktop'

app.setName(FLAVOR === 'dev' ? 'Mikka Dev' : 'Mikka')
if (process.platform === 'win32') app.setAppUserModelId('com.aspectlylabs.mikka')
app.enableSandbox()

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

let mainWindow: BrowserWindow | null = null
let pendingClick: string | null = null
let pendingProtocol: string | null = null
let retrying: NodeJS.Timeout | null = null

function handleProtocolUrl(raw: string): void {
  const finish = desktopAuthFinishUrl(raw, APP_URL)
  if (!finish) return
  if (!app.isReady() || !mainWindow || mainWindow.isDestroyed()) {
    pendingProtocol = finish
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  void mainWindow.loadURL(finish)
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1])])
    return
  }
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
}

function deliverClick(href: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingClick = href
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send(IPC.notificationsClicked, href)
}

const notifications = new NotificationCenter(
  {
    isSupported: () => Notification.isSupported(),
    show: (title, body, onClick) => {
      const notification = new Notification({ title, body })
      notification.on('click', onClick)
      notification.show()
    },
    setBadge: count => {
      if (process.platform !== 'win32') app.setBadgeCount(count)
    },
  },
  deliverClick
)

function registerSession(): void {
  const appSession = session.fromPartition(PARTITION)
  appSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  appSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (new URL(details.url).origin === APP_ORIGIN) {
        details.requestHeaders['x-mikka-client'] = 'desktop'
        details.requestHeaders['x-mikka-client-version'] = APP_VERSION
      }
    } catch {
      // A malformed request URL is left untouched; the request still goes out.
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

function handleNavigation(event: Electron.Event, url: string): void {
  const decision = navigationDecision(url, APP_URL)
  if (decision === 'allow') return
  event.preventDefault()
  if (decision === 'external') {
    const target = externalUrl(url)
    if (target) void shell.openExternal(target)
  }
}

function openChild(url: string): void {
  const trusted = new URL(url).origin === APP_ORIGIN
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    parent: mainWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: PARTITION,
      devTools: !app.isPackaged,
      ...(trusted ? {
        preload: join(__dirname, 'preload.cjs'),
        additionalArguments: [`--mikka-app-origin=${APP_ORIGIN}`],
      } : {}),
    },
  })
  child.webContents.setWindowOpenHandler(details => {
    openWindow(details.url)
    return { action: 'deny' }
  })
  child.webContents.on('will-navigate', (event, next) => handleNavigation(event, next))
  child.webContents.on('will-redirect', (event, next) => handleNavigation(event, next))
  void child.loadURL(url)
}

function openWindow(url: string): void {
  const decision = navigationDecision(url, APP_URL)
  if (decision === 'allow') openChild(url)
  else if (decision === 'external') {
    const target = externalUrl(url)
    if (target) void shell.openExternal(target)
  }
}

function retryLater(): void {
  if (retrying) return
  retrying = setTimeout(() => {
    retrying = null
    if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(APP_URL)
  }, 5_000)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f5f5f4',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
      partition: PARTITION,
      additionalArguments: [`--mikka-app-origin=${APP_ORIGIN}`],
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(details => {
    openWindow(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('will-redirect', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('did-finish-load', () => {
    const loaded = mainWindow?.webContents.getURL() ?? ''
    if (retrying && loaded.startsWith(APP_ORIGIN)) { clearTimeout(retrying); retrying = null }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !validatedURL.startsWith(APP_ORIGIN)) return
    void mainWindow?.loadFile(join(__dirname, 'offline.html'))
    retryLater()
  })
  void mainWindow.loadURL(APP_URL)
}

function messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

let manualUpdateCheck = false
let updatePromptOpen = false

function reportUpdateError(error: Error): void {
  if (!manualUpdateCheck) return
  manualUpdateCheck = false
  void messageBox({
    type: 'error',
    message: 'Could not check for updates.',
    detail: error.message,
    buttons: ['OK'],
  })
}

function setupUpdates(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    if (updatePromptOpen) return
    updatePromptOpen = true
    void messageBox({
      type: 'info',
      message: `Mikka ${info.version} is available.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      updatePromptOpen = false
      if (response === 0) void autoUpdater.downloadUpdate().catch(reportUpdateError)
    })
  })
  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    void messageBox({ type: 'info', message: `Mikka ${APP_VERSION} is up to date.`, buttons: ['OK'] })
  })
  autoUpdater.on('update-downloaded', info => {
    updatePromptOpen = true
    void messageBox({
      type: 'info',
      message: `Mikka ${info.version} is ready.`,
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      updatePromptOpen = false
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })
  autoUpdater.on('error', reportUpdateError)
}

/**
 * The updater reads the signed ZIP and latest-mac.yml from the published
 * GitHub Release. Draft releases are invisible to it, so a release becomes
 * available only after the draft is published.
 */
async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) await messageBox({ type: 'info', message: 'Updates are checked in the installed app.', buttons: ['OK'] })
    return
  }
  manualUpdateCheck = interactive
  await autoUpdater.checkForUpdates().catch(reportUpdateError)
}

function installMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(app.isPackaged ? [{ label: 'Check for Updates…', click: () => { void checkForUpdates(true) } }] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' },
      ],
    },
  ]))
}

function start(): void {
  registerProtocol()
  registerSession()
  registerBridge({
    appUrl: APP_URL,
    openExternal: url => {
      const target = appExternalUrl(url, APP_URL)
      if (!target) throw new Error('openExternal accepts only app-origin HTTP(S) URLs')
      return shell.openExternal(target)
    },
    localDevice: localDeviceStatus,
    quota: localQuota,
    notifications,
    consumePendingClick: () => {
      const href = pendingClick
      pendingClick = null
      return href
    },
  })
  createMainWindow()
  if (pendingProtocol) {
    const finish = pendingProtocol
    pendingProtocol = null
    void mainWindow?.loadURL(finish)
  }
  installMenu()
  setupUpdates()
  if (app.isPackaged) setTimeout(() => { void checkForUpdates(false) }, 15_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })
  app.on('second-instance', (_event, argv) => {
    for (const argument of argv) {
      if (argument.startsWith(`${AUTH_PROTOCOL}://`)) handleProtocolUrl(argument)
    }
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  for (const argument of process.argv) {
    if (argument.startsWith(`${AUTH_PROTOCOL}://`)) handleProtocolUrl(argument)
  }
  void app.whenReady().then(start)
}
