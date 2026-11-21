import { mock, type TestContext } from 'node:test'

/** Writer fixtures run the real live fan-out, including the community edition's
 * independent PostgreSQL LISTEN session. Own that runtime alongside the pools:
 * closing application/workspace pools does not close the gateway's pg.Client. */
export async function ownLiveRuntime(t: Pick<TestContext, 'after'>) {
  const background = await import('../../lib/background')
  const jobs: Promise<unknown>[] = []
  const scheduler = mock.module(new URL('../../lib/background.ts', import.meta.url).href, {
    cache: true,
    namedExports: {
      ...background,
      afterJob: ((label, work, options) => background.afterJob(label, work, label === 'after:live-notify'
        ? { ...options, schedule: run => { jobs.push(Promise.resolve(run())) } }
        : options)) satisfies typeof background.afterJob,
    },
  })
  const { builtinGateway } = await import('../../lib/builtin-gateway/runtime')
  const gateway = builtinGateway()
  const flush = async () => {
    // Join imports registered by already committed writers, then await their
    // finite work and any nested live jobs. No sleep, polling or forced exit.
    await import('../../lib/background')
    while (jobs.length) await Promise.all(jobs.splice(0))
  }
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    try { await flush() }
    finally { scheduler.restore(); await gateway?.stop() }
  })()
  t.after(close)
  return { flush, close }
}
