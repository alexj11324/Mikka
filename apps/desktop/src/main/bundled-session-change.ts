import type { WebContents } from 'electron'
import { BUNDLED_IPC } from '@mikka/protocol/ipc'
import { isTrustedFrame } from './security'

export type BundledSessionChange = { pendingReturn: true }
type Contents = Pick<WebContents, 'isDestroyed' | 'getURL' | 'send'>

/** A successful PKCE return will load a new main document. Other windows still
 * retire their old account immediately; ordinary changes refresh every window. */
export function notifyBundledSessionChange(contents: readonly Contents[], main: Contents | null, pageURL: string, change?: BundledSessionChange) {
  for (const target of contents) {
    if (target.isDestroyed() || !isTrustedFrame(target.getURL(), pageURL) || change?.pendingReturn && target === main) continue
    target.send(BUNDLED_IPC.sessionChanged)
  }
}
