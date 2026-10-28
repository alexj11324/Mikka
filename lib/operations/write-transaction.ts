import type { Pool, PoolClient } from 'pg'
import { MailboxError } from '@/lib/mailbox-error'
import { cancelMailboxBackend } from '@/lib/mailbox-pg-cancel'
import { waitForMailboxGuard, type MailboxTransactionGuard, type MailboxTransactionLease } from '@/lib/mailbox-transaction-guard'

export interface WriteActor { userId: string; sessionId: string }
export interface WriteRequestContext { signal?: AbortSignal; actor?: WriteActor }
export interface WriteTransactionOptions {
  signal?: AbortSignal
  /** Acquired only after work holds APP authorization locks; retained through COMMIT. */
  guard?: MailboxTransactionGuard
  authorizeCommit?: (client: PoolClient) => Promise<void>
  begin?: 'BEGIN' | 'BEGIN ISOLATION LEVEL REPEATABLE READ'
  /** Host/test dependency only. Never selected by request arguments. */
  cancel?: typeof cancelMailboxBackend
}
const cancelled = () => new MailboxError('writeTransactionCancelled', 409)

/** Transaction ownership only, never approval/effect authority. A cancelled or
 * uncertain connection is discarded, never returned to another pool borrower.
 * No retry, new credentials, session claim writer or secondary ledger. */
export async function writeTransaction<T>(pool: Pick<Pool, 'connect'>, work: (client: PoolClient) => Promise<T>, options: WriteTransactionOptions = {}): Promise<T> {
  const controller = new AbortController()
  const signals = [options.signal, options.guard?.signal].filter((s): s is AbortSignal => !!s)
  const abort = () => controller.abort()
  for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() }
  let raw: PoolClient | undefined, lease: MailboxTransactionLease | undefined
  let began = false, commitSent = false, committed = false, released = false, appQuerySent = false
  let guardPending: Promise<MailboxTransactionLease> | undefined, closingLease: Promise<void> | undefined
  let discard: Error | undefined, cancellation: Promise<unknown> | undefined, result!: T, failure: unknown
  const cleanupFailure = (cause: unknown) => {
    discard ??= cancelled()
    const error = new MailboxError('writeTransactionCleanupUncertain', commitSent && !committed ? 409 : 503, committed ? 'committed' : commitSent ? 'unconfirmed' : undefined)
    error.cause = cause; failure = error
  }
  const check = () => { if (controller.signal.aborted) throw cancelled() }
  const onConnectionError = () => { discard ??= cancelled(); controller.abort() }
  const cancel = () => {
    discard ??= cancelled()
    if (raw && appQuerySent && !committed && !cancellation) cancellation = Promise.resolve().then(() => (options.cancel ?? cancelMailboxBackend)(raw!)).catch(() => undefined)
  }
  controller.signal.addEventListener('abort', cancel, { once: true })
  const release = (client: PoolClient, error?: Error) => { if (!released) { released = true; client.release(error) } }
  const closeLease = () => lease ? closingLease ??= Promise.resolve().then(() => lease!.close()) : Promise.resolve()
  try {
    check()
    const connection = pool.connect().then(client => {
      raw = client // Register ownership before the abortable waiter can reject.
      if (controller.signal.aborted) { release(client, cancelled()); throw cancelled() }
      return client
    })
    raw = await waitForMailboxGuard(connection, controller.signal)
    // Real pg clients are EventEmitters; in-memory transports may omit listeners.
    raw.on?.('error', onConnectionError); raw.on?.('end', onConnectionError)
    const tx = new Proxy(raw, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => {
        check()
        appQuerySent = true
        return waitForMailboxGuard(Reflect.apply(target.query, target, args), controller.signal)
      }
      if (key === 'release') return () => { throw Error('writeTransactionOwnsConnection') }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    await tx.query(options.begin ?? 'BEGIN'); began = true
    check()
    result = await waitForMailboxGuard(work(tx), controller.signal)
    if (options.guard) {
      check()
      const pending = options.guard(tx, controller.signal).then(async acquired => {
        lease = acquired // Same ownership rule applies to a late authorization lease.
        if (controller.signal.aborted) { await closeLease(); throw cancelled() }
        return acquired
      })
      guardPending = pending
      lease = await waitForMailboxGuard(pending, controller.signal)
      lease.signal?.addEventListener('abort', abort, { once: true })
      if (lease.signal?.aborted) abort()
      await waitForMailboxGuard(lease.check(), controller.signal)
    }
    if (options.authorizeCommit) await waitForMailboxGuard(options.authorizeCommit(tx), controller.signal)
    check()
    // No awaited host work between the final check and dispatching COMMIT.
    commitSent = true
    const pendingCommit = raw.query('COMMIT').then(value => { committed = true; return value })
    await waitForMailboxGuard(pendingCommit, controller.signal)
  } catch (error) {
    failure = controller.signal.aborted ? cancelled() : error
    if (commitSent && !committed) { discard ??= cancelled(); failure = new MailboxError('writeCommitUnconfirmed', 409, 'unconfirmed') }
    else if (committed) failure = new MailboxError('writeCommitFinalizationFailed', 503, 'committed')
    if (raw && began && !commitSent && !controller.signal.aborted) {
      try { await waitForMailboxGuard(raw.query('ROLLBACK'), AbortSignal.timeout(2000)) }
      catch { discard ??= cancelled() }
    }
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', abort)
    lease?.signal?.removeEventListener('abort', abort)
    // A guard may have resolved just as its waiter was cancelled. Observe that
    // ownership transfer before closing; never report cleanup success on timeout.
    if (guardPending && !lease) {
      const timeout = AbortSignal.timeout(2000)
      try { await waitForMailboxGuard(guardPending, timeout) }
      catch (error) { if (timeout.aborted) cleanupFailure(error); else failure ??= error }
    }
    try { await closeLease() }
    catch (error) { cleanupFailure(error) }
    if (controller.signal.aborted) discard ??= cancelled()
    await cancellation
    controller.signal.removeEventListener('abort', cancel)
    if (raw) {
      raw.removeListener?.('error', onConnectionError); raw.removeListener?.('end', onConnectionError)
      try { release(raw, discard) }
      catch (error) { cleanupFailure(error) }
    }
  }
  if (failure) throw failure
  return result
}
