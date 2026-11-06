// A run receives its actual subscription access lease with the claim. The
// provider transport never visits Mikka. Only natural token expiry schedules
// another credential fetch; CLI refresh callbacks read this prepared cache.
import { nativeLeaseSchema, type NativeLease, type RunAssignment } from '@mikka/protocol'
import type { ServerLink } from './server-link'
import { daemonTracer, runIdHash } from './tracing'
import { runRuntimeTimings } from './run-runtime-timing'

// The worker refreshes inside its last 60 s. Enter that window with enough
// room for IPC/network, rather than racing the same threshold from the client.
const REFRESH_LEAD_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1

export interface PreparedSubscription {
  readonly first: NativeLease
  current(): NativeLease
  /** Explicit native token-expiry notification; schedules work without waiting. */
  refresh(): void
  close(): void
}

export async function prepareSubscriptionCredentials(assignment: RunAssignment, host: {
  link: Pick<ServerLink, 'nativeLease'>
  signal: AbortSignal
  onCredential?(name: string, value: string): void
  onRefreshError?(): void
}): Promise<PreparedSubscription> {
  const selected = assignment.subscriptionBinding
  if (!selected) throw Error('subscription_assignment_invalid')
  const attributes = { 'mikka.run.id_hash': runIdHash(assignment.runId), 'mikka.harness': assignment.harness }
  const request = async () => {
    if (!host.link.nativeLease || host.signal.aborted) throw Error('subscription_lease_unavailable')
    return nativeLeaseSchema.parse(await host.link.nativeLease(assignment.deviceId, assignment.runId, host.signal))
  }
  // Older servers can still supply the same owner-bound lease once. A new
  // claim already prepared it alongside GitHub/setup and incurs no extra RTT.
  const first = nativeLeaseSchema.parse(assignment.subscriptionLease ??
    await daemonTracer.span('daemon.adapter.auth.lease', attributes, request))
  const valid = (lease: NativeLease) => {
    if (lease.route !== selected.route || lease.modelId !== assignment.model ||
      lease.accountId !== first.accountId || lease.revision !== first.revision ||
      Date.parse(lease.expiresAt) <= Date.now()) throw Error('subscription_lease_changed')
    return lease
  }
  valid(first)
  let current: NativeLease | undefined = first
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshing: Promise<void> | undefined
  let attemptedExpiry: string | undefined
  let failures = 0
  host.onCredential?.('SUBSCRIPTION_ACCESS_TOKEN', first.accessToken)

  const at = (due: number) => {
    clearTimeout(timer)
    if (closed || host.signal.aborted) return
    timer = setTimeout(() => {
      if (due > Date.now()) at(due)
      else refresh()
    }, Math.min(MAX_TIMER_MS, Math.max(0, due - Date.now())))
    timer.unref?.()
  }
  const schedule = () => {
    if (!current || closed) return
    const expiry = Date.parse(current.expiresAt)
    // A server may keep a still-valid token at the first lead-time request.
    // In that case wait for its real expiry instead of polling for rotation.
    at(attemptedExpiry === current.expiresAt ? expiry : expiry - REFRESH_LEAD_MS)
  }
  function refresh() {
    if (closed || host.signal.aborted || refreshing || !current) return
    attemptedExpiry = current.expiresAt
    refreshing = runRuntimeTimings.backgroundCredentialRefresh(assignment.runId,
      () => daemonTracer.span('daemon.adapter.auth.refresh', attributes, request))
      .then(value => {
        if (closed || host.signal.aborted) return
        valid(value)
        host.onCredential?.('SUBSCRIPTION_ACCESS_TOKEN', value.accessToken)
        current = value
        failures = 0
        schedule()
      }).catch(() => {
        if (closed || host.signal.aborted) return
        host.onRefreshError?.()
        // Bounded retries belong to the one expiry event. Provider/tool work
        // keeps using the valid cached token and never waits for these I/Os.
        failures++
        if (failures <= 3) at(Date.now() + Math.min(15_000, failures * 5_000))
      }).finally(() => { refreshing = undefined })
  }
  const close = () => {
    closed = true
    clearTimeout(timer)
    current = undefined
    host.signal.removeEventListener('abort', close)
  }
  host.signal.addEventListener('abort', close, { once: true })
  if (host.signal.aborted) close()
  else schedule()
  return {
    first,
    current() {
      if (closed || host.signal.aborted || !current) throw Error('subscription_run_closed')
      return valid(current)
    },
    refresh,
    close,
  }
}
