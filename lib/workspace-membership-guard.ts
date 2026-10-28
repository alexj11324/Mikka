import type { Pool, PoolClient, QueryConfig } from 'pg'
import { waitForMailboxGuard, type MailboxTransactionLease } from './mailbox-transaction-guard'
import { MailboxError } from './mailbox-error'
import { cancelMailboxBackend } from './mailbox-pg-cancel'
import { mailboxDiagnostic } from './mailbox-diagnostics'

/** A read transaction pins membership against ordinary UPDATE and DELETE.
 * FOR SHARE is deliberate: KEY SHARE would not block a status UPDATE.
 * Caller reserves APP and locks its grant head first, matching AgentKit
 * initialization's APP-head -> workspace authorization order.
 */
export async function acquireWorkspaceMembership(pool: Pick<Pool, 'connect'>, identity: {
  workspaceId: string; userId: string
}, signal?: AbortSignal): Promise<MailboxTransactionLease> {
  const denied = () => new MailboxError('Workspace membership lease unavailable or cancelled', 403)
  if (signal?.aborted) throw denied()
  let began = false, closed = false, failed = false
  const controller = new AbortController()
  const deadline = Date.now() + 20000
  const fail = () => { failed = true; controller.abort() }
  signal?.addEventListener('abort', fail, { once: true })
  if (signal?.aborted) fail()
  const timer = setTimeout(fail, 20000); timer.unref()
  // Own checkout in its callback, before any later Promise/await microtask can
  // lose admission to cancellation. A detached or late checkout is idle and
  // can be discarded; an admitted client only leaves through close below.
  let owned: PoolClient | undefined, admissionClosed = false
  const releaseOwned = (error?: Error) => {
    const raw = owned
    if (!raw) return
    owned = undefined
    raw.removeListener('error', fail); raw.removeListener('end', fail)
    raw.release(error)
  }
  let client: PoolClient
  try {
    const connection = pool.connect().then(raw => {
      owned = raw
      raw.on('error', fail); raw.on('end', fail)
      if (admissionClosed || controller.signal.aborted) { releaseOwned(denied()); throw denied() }
      return raw
    })
    client = await waitForMailboxGuard(connection, controller.signal)
    if (controller.signal.aborted) throw denied()
  } catch (error) {
    admissionClosed = true
    clearTimeout(timer); signal?.removeEventListener('abort', fail)
    releaseOwned(denied())
    throw error
  }
  admissionClosed = true
  const assert = () => { if (closed || failed || signal?.aborted || Date.now() >= deadline) throw denied() }
  // pg supports per-query read timeout; @types/pg only declares it on client
  // config. Retain the official runtime field without widening caller inputs.
  const query = (config: QueryConfig & { query_timeout: number }) => { assert(); return waitForMailboxGuard(client.query(config), controller.signal) }
  const close = async () => {
    if (closed) return
    closed = true; clearTimeout(timer); signal?.removeEventListener('abort', fail)
    let discard: Error | undefined = failed ? denied() : undefined
    if (began && !failed) {
      try { const config: QueryConfig & { query_timeout: number } = { text: 'rollback', query_timeout: 2000 }; await waitForMailboxGuard(client.query(config), AbortSignal.timeout(2000)) }
      catch { discard = denied() }
    }
    if (failed) await cancelMailboxBackend(client)
    mailboxDiagnostic('ws.release', { backendPID: (client as unknown as { processID?: number }).processID, outcome: discard ? 'discard' : 'reuse' })
    releaseOwned(discard)
  }
  try {
    await query({ text: 'begin', query_timeout: 2000 }); began = true
    await query({ text: "select set_config('lock_timeout','5s',true),set_config('statement_timeout','5s',true),set_config('idle_in_transaction_session_timeout','30s',true)", query_timeout: 6000 })
    const result = await query({ text: 'select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\' for share', values: [identity.workspaceId, identity.userId], query_timeout: 6000 })
    assert()
    if (!result.rowCount) throw denied()
    return {
      signal: controller.signal,
      workspaceClient: { query: ((...args: unknown[]) => { assert(); return waitForMailboxGuard(Reflect.apply(client.query, client, args), controller.signal) }) as PoolClient['query'] },
      async check() { assert(); await query({ text: 'select 1', query_timeout: 2000 }); assert() },
      close,
    }
  } catch (error) { if (!(error instanceof MailboxError)) failed = true; await close(); throw error }
}
