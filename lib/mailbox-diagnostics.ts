import { channel } from 'node:diagnostics_channel'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const events = channel('mikka.personal-mailbox.lifecycle')
const context = new AsyncLocalStorage<{ requestId: string; runId: string }>()
/** Host-only observations. No SQL/arguments, credentials or cancellation keys.
 * Subscribers are trusted host code and must catch their own errors:
 * diagnostics_channel can surface their exceptions outside this call stack. */
export function mailboxDiagnostic(stage: string, details: { backendPID?: number; sqlState?: string; aborted?: boolean; outcome?: string } = {}) {
  if (!events.hasSubscribers) return
  try { events.publish({ at: new Date().toISOString(), sourcePID: process.pid, ...context.getStore(), stage, ...details }) } catch { /* best-effort publication; no authority or work inputs change */ }
}
export function withMailboxDiagnostics<T>(runId: string, signal: AbortSignal, work: () => Promise<T>) {
  const identity = { requestId: randomUUID(), runId }
  return context.run(identity, async () => {
    // EventEmitter/AbortSignal callbacks execute in the aborting caller's
    // context, so explicitly retain this authenticated request correlation.
    const abort = () => context.run(identity, () => mailboxDiagnostic('http.abort', { aborted: true }))
    signal.addEventListener('abort', abort, { once: true })
    mailboxDiagnostic('http.enter', { aborted: signal.aborted })
    if (signal.aborted) abort()
    try { return await work() }
    finally { mailboxDiagnostic('http.leave', { aborted: signal.aborted }); signal.removeEventListener('abort', abort) }
  })
}
