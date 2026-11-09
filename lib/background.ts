// oxlint-disable-next-line no-restricted-imports -- the one place that schedules after() work
import { after } from 'next/server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { waitUntil } from '@vercel/functions'
import { context } from '@opentelemetry/api'
import { runJob, type JobKind } from '@/lib/tracing/jobs'
import { withBackgroundDeviceAuthority } from '@/lib/db/device-scope'

// Work that outlives its request, labelled as its own job for tracing and the
// db_sample log (docs/operations/tracing.md, "Background work").

/** A fixed job name, never ids or user data: `after:<job>` or `cron:<route>/<part>`. */
export type JobLabel = `after:${string}` | `cron:${string}`

export type AfterJobOptions = {
  /** Outside a request (a script, a test) run the work now, kept alive with waitUntil, instead of throwing as after() does. */
  orRun?: boolean
  /**
   * Keep the scheduling call's async context (its request database scope) even
   * when the scheduler invokes the work from another context, as
   * AsyncLocalStorage.bind does. The job's label is entered inside the bound
   * function, so it still wins over the scheduling request's.
   */
  retainContext?: boolean
  /** Test seam for next/server's after(). */
  schedule?: (task: () => unknown) => void
}

const kindOf = (label: JobLabel): JobKind => (label.startsWith('cron:') ? 'cron' : 'background')

/**
 * next/server's after(), with the deferred work run as its own job: a child
 * span named `label`, under the request that scheduled it, with that label
 * as `mikka.route` and `mikka.client_kind` `background` (`cron` for `cron:`).
 *
 * after() runs its callback in a snapshot of the scheduling request's async
 * context (Next's bindSnapshot), so without this the work's queries would
 * carry the request's route, under a request span that has already ended.
 * runJob is entered inside that callback, after the snapshot is restored, so
 * its label is the one in force when the work runs. Do not bind `task` itself
 * with AsyncLocalStorage.bind/snapshot (entering it would restore the
 * request's context over the label); use `retainContext` instead.
 */
export function afterJob(label: JobLabel, task: () => unknown, { orRun = false, retainContext = false, schedule = after }: AfterJobOptions = {}): void {
  const parent = context.active()
  const job = () => context.with(parent, () => runJob(label, kindOf(label), () => withBackgroundDeviceAuthority(task), { detach: true }))
  const run = retainContext ? AsyncLocalStorage.bind(job) : job
  try { schedule(run) } catch (error) {
    if (!orRun) throw error
    let pending: unknown
    try { pending = run() } catch { return }
    waitUntil(Promise.resolve(pending).catch(() => {}))
  }
}

/** Wraps a cron route handler, so its queries carry `cron:<name>` and `mikka.client_kind=cron` inside the request span. */
export function cronJob<A extends unknown[], R>(name: string, handler: (...args: A) => R): (...args: A) => R {
  return (...args) => runJob(`cron:${name}`, 'cron', () => handler(...args))
}
