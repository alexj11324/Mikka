import { withBasePath } from '../base-path'
import { clearChatDrafts } from '../chat-drafts'
import { clearPersistentReadCaches } from '../swr/persistent-cache'
import { canonicalWebServer } from './policy'
import { WebConnectionError, WebServerDirectory } from './client'
import { installWebSelection } from './selection'
import { clearWebServerAssets } from './assets'
export { downloadServerFile } from './assets'

let directory: WebServerDirectory | null = null
const installed = Symbol.for('mikka.web.server-transport')
const emptySnapshot = { version: 0, account: null, expiredServer: null }
export const webServerSnapshot = () => directory?.getSnapshot() ?? emptySnapshot
export const subscribeWebServers = (changed: () => void) => directory?.subscribe(changed) ?? (() => {})
export const currentWebServers = () => directory

/** Installed by the official browser entry, never by Electron/iOS or a server
 * render. The browser owns this state; no selected URL/token goes to the cloud. */
export function installWebServerTransport(target: Window) {
  const state = target as Window & { [installed]?: true }
  if (state[installed]) return
  const appUrl = `${target.location.origin}${withBasePath('/')}`
  if (!canonicalWebServer(appUrl)) return
  const original = target.fetch.bind(target)
  let storage: Storage | undefined, sessionStorage: Storage | undefined
  try { storage = target.localStorage; sessionStorage = target.sessionStorage } catch { /* Browser storage can be denied. */ }
  directory = new WebServerDirectory({ appUrl, fetch: original, storage, sessionStorage, onChange: async () => {
    clearWebServerAssets()
    clearChatDrafts()
    await clearPersistentReadCaches()
  } })
  installWebSelection(directory.getSnapshot)
  state[installed] = true
  target.fetch = directory.fetch
}

function required() {
  if (!directory && typeof window !== 'undefined') installWebServerTransport(window)
  if (!directory) throw new WebConnectionError('web_connection_https_required')
  return directory
}
export const getServers = () => required().getServers()
export const addServer = (input: unknown) => required().addServer(input)
/** null selects the original cloud cookie session, without changing it. */
export const switchServer = (server: string | null, userId?: string) => required().switchServer(server, userId)
export const disconnectServer = (server: string) => required().disconnectServer(server)

/** Must run directly from the click. Opening a blank popup before asynchronous
 * work avoids a blocked window; postMessage replaces any handoff polling. */
export async function signInToServer(server: string): Promise<void> {
  const owner = required()
  const popup = window.open('about:blank', 'mikka-server-sign-in', 'popup,width=520,height=720')
  if (!popup) throw new WebConnectionError('web_connection_popup_blocked')
  try {
    const { cloudAuthClient } = await import('../auth-client')
    const cloud = await cloudAuthClient.multiSession.listDeviceSessions()
    if (cloud.error && cloud.error.status !== 401) throw new WebConnectionError('web_connection_session_unavailable')
    if (cloud.data) await owner.rememberCloudAccounts(cloud.data.map(account => account.user.id))
    if (owner.getSnapshot().expiredServer === server) {
      const probe = await owner.addServer(server)
      if (probe.status !== 'ok') throw new WebConnectionError('web_connection_probe_required')
    }
    const begin = await owner.beginSignIn(server)
    await new Promise<void>((resolve, reject) => {
      let consuming = false
      let channel: BroadcastChannel | undefined
      const cleanup = () => { window.removeEventListener('message', receive); channel?.close(); clearTimeout(timer) }
      const consume = (value: unknown) => {
        if (consuming || !value || typeof value !== 'object') return
        const message = value as { type?: unknown; state?: unknown; code?: unknown }
        if (message.type !== 'mikka.web.handoff' || message.state !== begin.state || typeof message.code !== 'string') return
        consuming = true
        cleanup()
        void owner.finishSignIn({ state: begin.state, code: message.code }).then(() => resolve(), reject)
      }
      const receive = (event: MessageEvent) => {
        if (event.origin === window.location.origin && event.source === popup) consume(event.data)
      }
      // One expiry deadline for a user-started login, not a polling task.
      const timer = setTimeout(() => { cleanup(); reject(new WebConnectionError('web_connection_handoff_expired')) }, 600_000)
      window.addEventListener('message', receive)
      // Some OAuth pages separate the popup's opener. A same-origin channel
      // named by the unguessable state preserves the one-time PKCE handoff.
      try {
        channel = new BroadcastChannel(`mikka.web.handoff:${begin.state}`)
        channel.onmessage = event => { if (event.origin === window.location.origin) consume(event.data) }
      } catch { /* postMessage remains available where BroadcastChannel is denied. */ }
      popup.location.replace(begin.signInUrl)
    })
  } finally { popup.close() }
}
