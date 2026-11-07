import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { BUNDLED_IPC } from '@mikka/protocol/ipc'
import type { BundledAuth } from './bundled-auth'
import type { BundledLive } from './bundled-live'
import type { BundledViewer } from './bundled-viewer'
import type { BundledServers } from './bundled-servers'
import { RENDERER_URL } from './bundled-policy'
import { trustedIpcSender } from './security'

export function registerBundledBridge(auth: BundledAuth, live: BundledLive, viewer: BundledViewer, servers?: BundledServers): void {
  const observed = new Set<number>()
  function handle(channel: string, run: (owner: number, ...input: unknown[]) => unknown) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...input: unknown[]) => {
      if (!trustedIpcSender(event.senderFrame, RENDERER_URL)) throw new Error('Untrusted IPC sender')
      const owner = event.sender.id
      if (!observed.has(owner)) {
        observed.add(owner)
        event.sender.once('destroyed', () => { observed.delete(owner); live.closeOwner(owner); viewer.closeOwner(owner) })
        event.sender.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { live.closeOwner(owner); viewer.closeOwner(owner) } })
      }
      return auth.whenRestored().then(() => {
        // Keychain restoration can outlive the invoking document. Recheck the
        // sender after that wait before running a privileged operation.
        if (event.sender.isDestroyed() || !trustedIpcSender(event.senderFrame, RENDERER_URL)) throw new Error('Untrusted IPC sender')
        return run(owner, ...input)
      }).catch(() => {
        // Never serialize an upstream response, token-bearing URL or native stack.
        throw new Error('desktop_request_failed')
      })
    })
  }
  handle(BUNDLED_IPC.session, () => auth.session())
  handle(BUNDLED_IPC.signIn, (_owner, input) => auth.signIn(input))
  handle(BUNDLED_IPC.signInEmail, (_owner, input) => auth.signInEmail(input))
  handle(BUNDLED_IPC.signOut, () => { live.closeAll(); viewer.closeAll(); return auth.signOut() })
  handle(BUNDLED_IPC.accounts, () => auth.accounts())
  handle(BUNDLED_IPC.linkAccount, (_owner, provider) => auth.linkAccount(provider))
  handle(BUNDLED_IPC.livePrepare, (owner, workspace) => live.prepare(owner, workspace))
  handle(BUNDLED_IPC.liveConnect, (owner, id) => live.connect(owner, id))
  handle(BUNDLED_IPC.liveSend, (owner, id, data) => live.send(owner, id, data))
  handle(BUNDLED_IPC.liveClose, (owner, id) => live.close(owner, id))
  handle(BUNDLED_IPC.viewerPrepare, (owner, input) => viewer.prepare(owner, input))
  handle(BUNDLED_IPC.viewerConnect, (owner, id) => viewer.connect(owner, id))
  handle(BUNDLED_IPC.viewerSend, (owner, id, data) => viewer.send(owner, id, data))
  handle(BUNDLED_IPC.viewerClose, (owner, id) => viewer.close(owner, id))
  if (!servers) return
  handle(BUNDLED_IPC.serverState, () => servers.state())
  handle(BUNDLED_IPC.serverProbe, (_owner, address) => servers.probe(address))
  handle(BUNDLED_IPC.serverSelect, (_owner, url) => { live.closeAll(); viewer.closeAll(); return servers.select(url ?? null) })
  handle(BUNDLED_IPC.serverDisconnect, (_owner, url) => { live.closeAll(); viewer.closeAll(); return servers.disconnect(url) })
  // The preload reads this once per page load for `app.serverUrl`. It is the
  // public base the page addresses share links to, never a credential.
  ipcMain.on(BUNDLED_IPC.serverUrl, event => {
    event.returnValue = trustedIpcSender(event.senderFrame, RENDERER_URL) ? auth.serverUrl() : ''
  })
}
