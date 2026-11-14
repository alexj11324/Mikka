// Electron main: one window on the shared web UI, plus the native abilities
// the UI reads through `window.mikka`. The renderer is treated as untrusted;
// every privileged call goes through the validated IPC surface in `./bridge`.

import { app, BrowserWindow, Menu, Notification, dialog, nativeTheme, net, protocol, safeStorage, session, shell, webContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { isAbsolute, join } from 'node:path'

import { IPC, BUNDLED_IPC } from '@mikka/protocol/ipc'

import { registerBridge } from './bridge'
import { localDeviceStatus, localQuota } from './daemon'
import { connectForUpdate, updateLocalDaemon } from './daemon-update'
import { readLocalDeviceAccount, readLocalDeviceOwner } from './local-setup'
import { AppLoadState, offlineReason, offlineRetryDelay } from './offline'
import { startLoopbackAuth, type LoopbackAuthServer } from './loopback'
import { startReturnListener, type ReturnListener } from './return-listener'
import { catchClaudeCallback } from './subscription-callback'
import { NotificationCenter } from './notification-center'
import { appExternalUrl, desktopAuthState, externalUrl, isTrustedFrame, navigationDecision } from './security'
import { UPDATE_CHECK_INTERVAL_MS, Updates, updateCopy } from './updates'
import { UpdateGate, gateCopy, gateView, type GateState } from './launch-update'
import { meetsMinimumVersion } from '@mikka/protocol/version'
import { TRANSLUCENT_ARGUMENT, windowAppearance } from './window-appearance'
import { RENDERER_ORIGIN, RENDERER_URL } from './bundled-policy'
import { bundledProtocol } from './bundled-protocol'
import { BundledAuth } from './bundled-auth'
import { notifyBundledSessionChange } from './bundled-session-change'
import { BundledLive } from './bundled-live'
import { BundledViewer } from './bundled-viewer'
import { registerBundledBridge } from './bundled-bridge'
import { SessionVault } from './session-vault'
import { ServerDirectory } from './server-directory'
import { BundledServers } from './bundled-servers'
import { AppLinks, appLinkFromArgv, appLinkScheme } from './app-link'
import { pickRepo } from './repo-picker'
import { openBundledWebPage } from './bundled-web'
import { newWindowMenuItem } from './window-menu'
import { markStartup } from '../startup'

const APP_URL = __MIKKA_APP_URL__
const APP_VERSION = __MIKKA_APP_VERSION__
const FLAVOR = __MIKKA_FLAVOR__
const APP_ORIGIN = new URL(APP_URL).origin
const BUNDLED = process.env.MIKKA_DESKTOP_RENDERER !== 'hosted'
const PARTITION = `${FLAVOR === 'dev' ? 'persist:mikka-dev' : 'persist:mikka'}${BUNDLED ? '-bundled' : ''}`
const PAGE_URL = BUNDLED ? RENDERER_URL : APP_URL
const PAGE_ORIGIN = BUNDLED ? RENDERER_ORIGIN : APP_ORIGIN

// Custom schemes need this explicit opt-in to retain V8's normal compiled-code
// cache across launches, as the hosted http(s) renderer already does.
protocol.registerSchemesAsPrivileged([{ scheme: 'mikka', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])

app.setName(FLAVOR === 'dev' ? 'Mikka Dev' : 'Mikka')
// Dev and production never share keychain ciphertext or Chromium state.
const profile = process.env.MIKKA_USER_DATA_DIR
if (profile && isAbsolute(profile)) app.setPath('userData', profile)
else if (FLAVOR === 'dev') app.setPath('userData', join(app.getPath('appData'), 'Mikka Dev'))
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
let bundledAuth: BundledAuth | null = null
let bundledLive: BundledLive | null = null
let bundledViewer: BundledViewer | null = null
/** The server the open page was loaded for; its preload reads `app.serverUrl` once. */
let shownServer: string | null = null
let gateWindow: BrowserWindow | null = null
// A browser sign-in ends on a page that opens this app's link; the system then
// brings the app forward, which macOS does not let the app do by itself.
const appLinks = new AppLinks(appLinkScheme(FLAVOR))

function bringToFront(): void {
  if (gateWindow && !gateWindow.isDestroyed()) { gateWindow.show(); gateWindow.focus(); return }
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  // Opened by the person's click in the browser, so taking the front is expected.
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
}

// macOS delivers an opened link here, before `ready` on a cold start. A link
// this process did not hand out (or one that expired) is ignored.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (appLinks.accepts(url)) bringToFront()
})

function closeAuthServer(): void {
  if (authTimer) { clearTimeout(authTimer); authTimer = null }
  if (authServer) { authServer.close(); authServer = null }
}

/**
 * Starts a one-shot HTTP listener bound to 127.0.0.1 and returns its callback.
 * The renderer registers that callback with the web app before opening the
 * browser, so the token can only be delivered to this process. The app link
 * on its last page only brings the window forward; it carries no credential.
 */
async function prepareAuth(rawState: unknown): Promise<string> {
  const state = desktopAuthState(rawState)
  if (!state) throw new Error('prepareAuth needs a desktop nonce')
  closeAuthServer()
  const listener = await startLoopbackAuth({
    state,
    appUrl: APP_URL,
    link: appLinks.issue(),
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

let returnListener: ReturnListener | null = null
let returnTimer: NodeJS.Timeout | null = null
function closeReturnListener(): void {
  returnListener?.close(); returnListener = null
  if (returnTimer) { clearTimeout(returnTimer); returnTimer = null }
}

/**
 * A link the page finishes in the system browser (Plugins → GitHub): a
 * one-shot 127.0.0.1 listener for its return. When it comes, the window comes
 * forward and the page is told the result, then finishes the link itself.
 */
async function prepareReturn(rawState: string): Promise<string> {
  closeReturnListener()
  const listener = await startReturnListener({
    state: rawState,
    onReturn: result => {
      returnListener = null
      if (returnTimer) { clearTimeout(returnTimer); returnTimer = null }
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      const contents = mainWindow.webContents
      if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(IPC.appReturned, { state: rawState, result })
    },
  })
  returnListener = listener
  returnTimer = setTimeout(closeReturnListener, 10 * 60_000)
  return listener.returnTo
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
  appSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && contents !== null && isTrustedFrame(contents.getURL(), PAGE_URL))
  })
  appSession.setPermissionCheckHandler((contents, permission) => permission === 'clipboard-sanitized-write' && contents !== null && isTrustedFrame(contents.getURL(), PAGE_URL))
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (!BUNDLED && new URL(details.url).origin === APP_ORIGIN) {
        details.requestHeaders['x-mikka-client'] = 'desktop'
        details.requestHeaders['x-mikka-client-version'] = APP_VERSION
      }
    } catch {
      // A malformed request URL is left untouched; the request still goes out.
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

/** The current account's server (#1557), or the sign-in page's; the build's server in hosted mode. */
function currentServer(): string {
  return bundledAuth?.serverUrl() ?? APP_URL
}

/** A page keeps the server it loaded with. When the window's server changes,
 * the page loads again so nothing from the previous server stays on screen. */
function reloadForServer(): boolean {
  const server = currentServer()
  if (shownServer === null || server === shownServer) return false
  shownServer = server
  if (!mainWindow || mainWindow.isDestroyed()) return true
  let english = false
  try { english = /^\/mikka\/en(?:\/|$)/.test(new URL(mainWindow.webContents.getURL()).pathname) } catch { /* not a page yet */ }
  void mainWindow.loadURL(english ? `${RENDERER_URL}/en` : RENDERER_URL)
  return true
}

function handleNavigation(event: Electron.Event, url: string): void {
  if (navigationDecision(url, PAGE_URL) === 'allow') return
  event.preventDefault()
  openOutside(url)
}

/** HTTP(S) and mailto go to the system browser; other schemes are denied. */
function openOutside(url: string): void {
  const target = externalUrl(url)
  if (target) void shell.openExternal(target)
}

function openChild(url: string): void {
  const trusted = isTrustedFrame(url, PAGE_URL)
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
        additionalArguments: [`--mikka-app-origin=${PAGE_ORIGIN}`],
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
  if (navigationDecision(url, PAGE_URL) === 'allow') openChild(url)
  else openOutside(url)
}

let offlineAttempt = 0
const appLoad = new AppLoadState(APP_ORIGIN)

function loadApp(): void {
  if (retrying) { clearTimeout(retrying); retrying = null }
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(PAGE_URL)
}

function showOffline(reason: 'network' | 'server'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const delay = offlineRetryDelay(offlineAttempt++)
  if (!mainWindow.webContents.getURL().startsWith('file:')) {
    void mainWindow.loadFile(join(__dirname, 'offline.html'), { query: { app: APP_URL, reason } })
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
  markStartup('main.window.start')
  // Read once at launch; a changed Reduce transparency setting applies from the next launch.
  const appearance = windowAppearance(process.platform, { dark: nativeTheme.shouldUseDarkColors, reduceTransparency: nativeTheme.prefersReducedTransparency })
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // The page paints its own top bar, so the native one must not show as a separate band.
    ...appearance.options,
    autoHideMenuBar: true,
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
      additionalArguments: [`--mikka-app-origin=${PAGE_ORIGIN}`, ...(appearance.translucent ? [TRANSLUCENT_ARGUMENT] : [])],
    },
  })
  markStartup('main.window.created')
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
    if (BUNDLED || !isMainFrame || errorCode === -3 || !validatedURL.startsWith(APP_ORIGIN)) return
    appLoad.failedLoad()
    showOffline(offlineReason(errorCode, net.isOnline()))
  })
  void mainWindow.loadURL(PAGE_URL)
}

function messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

/**
 * The updater reads the signed ZIP and latest-mac.yml from the published
 * GitHub Release. Draft releases are invisible to it, so a release becomes
 * available only after the draft is published. A downloaded update is
 * offered by the rail's restart button and installs on the next quit anyway.
 */
const copy = () => updateCopy(app.getLocale())
const updates = new Updates(autoUpdater, {
  ready: version => {
    void messageBox({ type: 'info', message: copy().restart(version), buttons: [copy().restartNow, copy().later], defaultId: 0, cancelId: 1 })
      .then(({ response }) => { if (response === 0) updates.install() })
  },
  upToDate: () => { void messageBox({ type: 'info', message: copy().upToDate(APP_VERSION), buttons: [copy().ok] }) },
  failed: error => { void messageBox({ type: 'error', message: copy().failed, detail: error.message, buttons: [copy().ok] }) },
}, version => {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(IPC.appUpdateReady, version)
  }
})

let gate: UpdateGate | null = null

/**
 * The launch gate (launch-update.ts): a small window that checks for an update
 * and, when there is one, installs it before `open` lets the person in.
 * Closing the window while it holds the door quits the app; there is no way
 * in on the old version.
 */
function runUpdateGate(open: () => void): void {
  if (gate) return
  const copy = gateCopy(app.getLocale())
  const win = new BrowserWindow({
    width: 360,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: copy.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#f5f5f4',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged },
  })
  gateWindow = win
  let loaded = false
  let pending: GateState | null = null
  let opened = false
  const render = (state: GateState) => {
    if (win.isDestroyed()) return
    if (!loaded) { pending = state; return }
    void win.webContents.executeJavaScript(`window.render(${JSON.stringify(gateView(state, copy))}, ${JSON.stringify(copy.lang)})`).catch(() => {})
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('did-navigate-in-page', (_event, url) => { if (new URL(url).hash === '#retry') gate?.retry() })
  win.webContents.once('did-finish-load', () => {
    loaded = true
    if (pending) render(pending)
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => {
    gateWindow = null
    if (!opened) app.quit()
  })
  gate = new UpdateGate(autoUpdater, {
    onState: render,
    onProceed: () => {
      opened = true
      gate = null
      if (!win.isDestroyed()) win.close()
      open()
    },
  })
  void win.loadFile(join(__dirname, 'update.html'))
  gate.start()
}

/**
 * The server's minimum desktop version (/api/version, MIN_CLIENT_VERSION, ADR
 * 0011). The page asks when it sees one above this build; main reads it again
 * itself, so a page cannot force an update the server does not require.
 */
async function enforceMinimumVersion(): Promise<void> {
  if (!app.isPackaged || FLAVOR === 'dev' || gate) return
  try {
    const server = currentServer()
    const response = await session.fromPartition(PARTITION).fetch(`${server.replace(/\/$/, '')}/api/version`, { headers: { origin: new URL(server).origin }, redirect: 'error', cache: 'no-store' })
    if (!response.ok) return
    const { minDesktopVersion } = await response.json() as { minDesktopVersion?: unknown }
    if (typeof minDesktopVersion !== 'string' || meetsMinimumVersion(APP_VERSION, minDesktopVersion)) return
  } catch {
    return
  }
  mainWindow?.hide()
  runUpdateGate(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    else createMainWindow()
  })
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged || FLAVOR === 'dev') {
    if (interactive) await messageBox({ type: 'info', message: copy().notInstalled, buttons: [copy().ok] })
    return
  }
  await updates.check(interactive)
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
      { label: 'File', submenu: [newWindowMenuItem(() => openChild(PAGE_URL))] },
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
        ...(app.isPackaged ? [{ label: copy().menu, click: () => { void checkForUpdates(true) } }] : []),
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
      label: 'File',
      submenu: [newWindowMenuItem(() => openChild(PAGE_URL))],
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

async function start(): Promise<void> {
  markStartup('main.ready')
  // The packaged Info.plist (electron-builder `protocols`) declares the scheme;
  // this makes this build its default handler. An unpackaged run would register Electron itself.
  if (app.isPackaged) app.setAsDefaultProtocolClient(appLinks.scheme)
  registerSession()
  let restoring = Promise.resolve()
  if (BUNDLED) {
    const backend = session.fromPartition(`${PARTITION}-backend`)
    // Which server the sign-in page targets; public facts only (server-directory.ts).
    const directory = new ServerDirectory(join(app.getPath('userData'), 'servers.json'), APP_URL)
    shownServer = directory.target()
    const vault = new SessionVault(join(app.getPath('userData'), 'credentials'), APP_URL, {
      available: async () => await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    })
    bundledAuth = new BundledAuth({
      serverUrl: APP_URL, version: APP_VERSION, vault,
      fetch: (url, init) => backend.fetch(url, init),
      openExternal: url => shell.openExternal(url),
      appLink: () => appLinks.issue(),
      target: directory.target(),
      targetChanged: url => directory.follow(url),
      describe: url => { const known = directory.info(url); return { url: known.url, cloud: directory.isCloud(url), name: known.name } },
      changed: change => {
        bundledLive?.closeAll()
        bundledViewer?.closeAll()
        if (reloadForServer()) return
        notifyBundledSessionChange(webContents.getAllWebContents(), mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null, PAGE_URL, change)
      },
      scopeChanged: () => { bundledLive?.closeAll(); bundledViewer?.closeAll() },
      returned: async next => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show(); mainWindow.focus()
        const path = next === '/' ? '/mikka' : next === '/mikka' || next.startsWith('/mikka/') || next.startsWith('/mikka?') ? next : `/mikka${next}`
        await mainWindow.loadURL(`${RENDERER_ORIGIN}${path}`)
      },
    })
    // Open the first backend socket while the OS keychain and local renderer
    // initialize. BundledAuth has validated this compiled origin; preconnect
    // sends no application HTTP request or session credential.
    backend.preconnect({ url: new URL(directory.target()).origin, numSockets: 1 })
    markStartup('main.backend.preconnect')
    markStartup('main.restore.start')
    restoring = bundledAuth.restore().then(() => { markStartup('main.restore.end'); reloadForServer() })
    bundledLive = new BundledLive(bundledAuth, (owner, event) => {
      const contents = webContents.fromId(owner)
      if (contents && !contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(BUNDLED_IPC.liveEvent, event)
    })
    bundledViewer = new BundledViewer(bundledAuth, (owner, event) => {
      const contents = webContents.fromId(owner)
      if (contents && !contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(BUNDLED_IPC.viewerEvent, event)
    })
    registerBundledBridge(bundledAuth, bundledLive, bundledViewer, new BundledServers(bundledAuth, directory, {
      fetch: (url, init) => backend.fetch(url, init),
      appVersion: APP_VERSION,
      enforceMinimum: app.isPackaged && FLAVOR === 'prod',
    }))
    session.fromPartition(PARTITION).protocol.handle('mikka', bundledProtocol(join(__dirname, 'renderer'), bundledAuth))
  }
  registerBridge({
    appUrl: APP_URL,
    serverUrl: currentServer,
    rendererUrl: PAGE_URL,
    flavor: FLAVOR,
    mintEnrollment: async () => {
      const url = `${APP_URL.replace(/\/$/, '')}/api/devices/enrollment`
      const init: RequestInit = {
        method: 'POST', headers: { origin: APP_ORIGIN }, redirect: 'error',
      }
      const response = bundledAuth ? await bundledAuth.request('/api/devices/enrollment', init) : await session.fromPartition(PARTITION).fetch(url, init)
      if (!response.ok) throw new Error('Sign in to register a device')
      const body = await response.json() as { token: string }
      return body.token
    },
    openExternal: async url => {
      await bundledAuth?.whenRestored()
      const server = currentServer()
      const target = appExternalUrl(url, server)
      if (!target) throw new Error('openExternal accepts only app-origin HTTP(S) URLs')
      if (bundledAuth && await openBundledWebPage(target, { serverUrl: server, auth: bundledAuth, openExternal: page => shell.openExternal(page) })) return
      await shell.openExternal(target)
    },
    prepareAuth: BUNDLED ? async () => { throw new Error('Use main-owned bundled sign-in / 请使用桌面登录') } : prepareAuth,
    prepareReturn,
    claudeCallback: url => catchClaudeCallback(url, page => shell.openExternal(page)),
    localDevice: localDeviceStatus,
    pickRepo,
    localAccount: () => readLocalDeviceAccount((url, init) => bundledAuth ? bundledAuth.request('/api/devices/enrollment', init) : session.fromPartition(PARTITION).fetch(url, init), APP_URL),
    localOwner: () => readLocalDeviceOwner((url, init) => bundledAuth ? bundledAuth.request('/api/devices/enrollment?view=owner', init) : session.fromPartition(PARTITION).fetch(url, init), APP_URL),
    quota: localQuota,
    notifications,
    consumePendingClick: () => {
      const href = pendingClick
      pendingClick = null
      return href
    },
    updates,
    requireUpdate: enforceMinimumVersion,
  })
  installMenu()
  const open = () => {
    createMainWindow()
    if (!app.isPackaged || FLAVOR === 'dev') return
    // This app may just have updated: the daemon on this computer updates too, when idle (daemon-update.ts).
    void updateLocalDaemon(FLAVOR, { connect: connectForUpdate({ name: 'mikka-desktop', version: APP_VERSION }) })
    // Background checks start once the app is open, so they never race the launch gate.
    setTimeout(() => { void checkForUpdates(false) }, 15_000)
    setInterval(() => { void checkForUpdates(false) }, UPDATE_CHECK_INTERVAL_MS)
  }
  // A cold start of the installed app installs any newer version first (launch-update.ts).
  if (app.isPackaged && FLAVOR === 'prod') runUpdateGate(open)
  else open()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !gate) createMainWindow()
  })
  // Only disk assets and the loading shell may overtake restoration. API and
  // IPC handlers already wait on BundledAuth's barrier before using any identity.
  await restoring
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows and Linux open the app link by starting a second instance with it.
    const link = appLinkFromArgv(argv, appLinks.scheme)
    if (link !== null && !appLinks.accepts(link)) return
    if (!mainWindow && !(gateWindow && !gateWindow.isDestroyed())) return
    bringToFront()
  })
  app.on('before-quit', closeAuthServer)
  app.on('before-quit', closeReturnListener)
  app.on('before-quit', () => { bundledAuth?.dispose(); bundledLive?.closeAll(); bundledViewer?.closeAll() })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(start)
}
