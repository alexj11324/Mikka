import type { PoolClient } from 'pg'
import { MailboxError } from './mailbox-error'

/** Host-owned read-lock lease. Reserve APP first, lock APP authorization
 * parents/head before WS member, then retain WS through APP effect commit. */
export interface MailboxTransactionLease {
  workspaceClient?: Pick<PoolClient, 'query'>
  signal?: AbortSignal
  check(): Promise<void>
  close(): Promise<void>
}
export interface MailboxTransactionGuard {
  (client: PoolClient, signal: AbortSignal): Promise<MailboxTransactionLease>
  signal?: AbortSignal
}

/** End waiting even if a socket/pool promise never settles. Callers destroy
 * their own detached client; a COMMIT already sent remains uncertain. */
export function waitForMailboxGuard<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new MailboxError('Mailbox authorization lease lost or cancelled', 403)) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
