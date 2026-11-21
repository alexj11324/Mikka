import { after, before, mock, type TestContext } from 'node:test'
import * as serverRuntime from '../../lib/server-runtime/server'

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

/** Unit writers still execute the real commit observer and live registration.
 * Stop only at the response scheduler: these fake databases cannot deliver live
 * reads. The captured callbacks prove registration, never notification delivery. */
export function captureFixtureLiveEffects() {
  const environment = { MIKKA_EDITION: 'community', BETTER_AUTH_URL: 'http://127.0.0.1:3000',
    BETTER_AUTH_SECRET: 'synthetic-unit-commit-fixture', DEVICE_GATEWAY_URL: undefined,
    DEVICE_GATEWAY_PUSH_SECRET: undefined, VERCEL: undefined }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  const scheduled: Parameters<typeof serverRuntime.after>[0][] = []
  const scheduler = mock.module(new URL('../../lib/server-runtime/server.ts', import.meta.url).href, {
    namedExports: { ...serverRuntime, after: (work: Parameters<typeof serverRuntime.after>[0]) => { scheduled.push(work) } },
  })
  // Register at module scope, alongside the caller's hooks. Registering after()
  // inside before() would restore the environment before any test body runs.
  before(() => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  after(() => {
    scheduler.restore()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  return scheduled
}
