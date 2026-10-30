// Electron main: one window on the shared web UI, plus the native abilities
// the UI reads through `window.mikka`. The renderer is treated as untrusted;
// every privileged call goes through the validated IPC surface in `./bridge`.

import { app, BrowserWindow, Menu, Notification, dialog, nativeTheme, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'

import { IPC } from '@mikka/protocol/ipc'

import { registerBridge } from './bridge'
import { localDeviceStatus, localQuota } from './daemon'
import { AppLoadState, offlineRetryDelay } from './offline'
import { startLoopbackAuth, type LoopbackAuthServer } from './loopback'
import { NotificationCenter } from './notification-center'
import { appExternalUrl, desktopAuthState, externalUrl, insecureExternalUrl, navigationDecision } from './security'

const APP_URL = __MIKKA_APP_URL__
const APP_VERSION = __MIKKA_APP_VERSION__
const FLAVOR = __MIKKA_FLAVOR__
const PARTITION = FLAVOR === 'dev' ? 'persist:mikka-dev' : 'persist:mikka'
const APP_ORIGIN = new URL(APP_URL).origin

app.setName(FLAVOR === 'dev' ? 'Mikka Dev' : 'Mikka')
if (process.platform === 'win32') app.setAppUserModelId('com.aspectlylabs.mikka')
app.enableSandbox()

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

let mainWindow: BrowserWindow | null = null
let pendingClick: string | null = null
let retrying: NodeJS.Timeout | null = null
let authServer: LoopbackAuthServer | null = null
let authTimer: NodeJS.Timeout | null = null

function closeAuthServer(): void {
  if (authTimer) { clearTimeout(authTimer); authTimer = null }
  if (authServer) { authServer.close(); authServer = null }
}

/**
 * Starts a one-shot HTTP listener bound to 127.0.0.1 and returns its callback.
 * The renderer registers that callback with the web app before opening the
 * browser, so the token can only be delivered to this process. No custom URL
 * scheme is registered.
 */
async function prepareAuth(rawState: unknown): Promise<string> {
  const state = desktopAuthState(rawState)
  if (!state) throw new Error('prepareAuth needs a desktop nonce')
  closeAuthServer()
  const listener = await startLoopbackAuth({
    state,
    appUrl: APP_URL,
    onFinish: finish => {
      authServer = null
      if (authTimer) { clearTimeout(authTimer); authTimer = null }
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      void mainWindow.loadURL(finish)
    },
  })
  authServer = listener
  authTimer = setTimeout(closeAuthServer, 10 * 60_000)
  return listener.callback
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
  if (navigationDecision(url, APP_URL) === 'allow') return
  event.preventDefault()
  openOutside(url)
}

const INSECURE_LINK_COPY = {
  zh: { message: '链接未加密', open: '在浏览器中打开', cancel: '取消' },
  en: { message: 'This link is not encrypted', open: 'Open in browser', cancel: 'Cancel' },
} as const
let insecurePromptOpen = false

/**
 * HTTPS and mailto go to the system browser. A plain-HTTP link used to be
 * dropped without a word; it still never opens on its own, but the user sees
 * it and can choose to open it in the browser, as the web app would.
 */
function openOutside(url: string): void {
  const target = externalUrl(url)
  if (target) { void shell.openExternal(target); return }
  const insecure = insecureExternalUrl(url)
  if (!insecure || insecurePromptOpen) return
  insecurePromptOpen = true
  const copy = INSECURE_LINK_COPY[app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en']
  void messageBox({ type: 'warning', message: copy.message, detail: insecure, buttons: [copy.open, copy.cancel], defaultId: 1, cancelId: 1, noLink: true })
    .then(({ response }) => { if (response === 0) return shell.openExternal(insecure) })
    .catch(() => {})
    .finally(() => { insecurePromptOpen = false })
}

function openChild(url: string): void {
  const trusted = new URL(url).origin === APP_ORIGIN
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    autoHideMenuBar: true,
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
  if (navigationDecision(url, APP_URL) === 'allow') openChild(url)
  else openOutside(url)
}

let offlineAttempt = 0
const appLoad = new AppLoadState(APP_ORIGIN)

function loadApp(): void {
  if (retrying) { clearTimeout(retrying); retrying = null }
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(APP_URL)
}

function showOffline(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const delay = offlineRetryDelay(offlineAttempt++)
  if (!mainWindow.webContents.getURL().startsWith('file:')) {
    void mainWindow.loadFile(join(__dirname, 'offline.html'), { query: { app: APP_URL } })
  }
  if (retrying) clearTimeout(retrying)
  retrying = setTimeout(() => { retrying = null; loadApp() }, delay)
}

/** Reload goes back to the app, never to the offline file it is showing. */
function reloadApp(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.getURL().startsWith('file:')) loadApp()
  else mainWindow.webContents.reload()
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // The page paints its own top bar, so the native one must not show as a separate band.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f4',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
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
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(details => {
    openWindow(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('will-redirect', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) appLoad.started(details.url)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (appLoad.finished(mainWindow?.webContents.getURL() ?? '')) {
      offlineAttempt = 0
      if (retrying) { clearTimeout(retrying); retrying = null }
    }
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !mainWindow?.webContents.getURL().startsWith('file:')) return
    const reload = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')
    if (!reload) return
    event.preventDefault()
    loadApp()
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !validatedURL.startsWith(APP_ORIGIN)) return
    appLoad.failedLoad()
    showOffline()
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

/**
 * Ctrl/Cmd+= zooms in without Shift (Electron's default is Plus, which needs
 * Shift on US layouts); a hidden Plus item keeps Ctrl/Cmd+Shift+= and keypad +.
 */
const ZOOM_ITEMS: Electron.MenuItemConstructorOptions[] = [
  { role: 'resetZoom' },
  { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
  { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', visible: false },
  { role: 'zoomIn', accelerator: 'CommandOrControl+numadd', visible: false },
  { role: 'zoomOut' },
  { role: 'zoomOut', accelerator: 'CommandOrControl+numsub', visible: false },
]

function installMenu(): void {
  if (process.platform !== 'darwin') {
    // Windows and Linux show no menu bar; the menu stays only to keep its shortcuts.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ label: 'Reload', accelerator: 'CommandOrControl+R', click: reloadApp }, ...ZOOM_ITEMS, ...(app.isPackaged ? [] : [{ role: 'forceReload' as const }, { role: 'toggleDevTools' as const }])] },
    ]))
    return
  }
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
        { label: 'Reload', accelerator: 'CommandOrControl+R', click: reloadApp }, { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        ...ZOOM_ITEMS,
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
  registerSession()
  registerBridge({
    appUrl: APP_URL,
    openExternal: url => {
      const target = appExternalUrl(url, APP_URL)
      if (!target) throw new Error('openExternal accepts only app-origin HTTP(S) URLs')
      return shell.openExternal(target)
    },
    prepareAuth,
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
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', closeAuthServer)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(start)
}
