import { createHash } from 'node:crypto'
import { CLOUD_WORKER_COMMAND } from '../../lib/computer/worker-command'
import { templateModelsFixture } from './template-models'
// A cloud run's own thread machine, as production provisions it, with only E2B
// replaced: the real ensureThreadMachine records the sandbox, the thread device
// and its repository, and moves the queued run onto that device. The fake
// sandbox's worker "registers" when its start command consumes the bootstrap, reporting
// the given harnesses (a task machine reports no computer broker).
import type { Pool } from 'pg'

type Harness = Record<string, unknown>

export async function fakeThreadMachines(pool: Pool, harnesses: Harness[]) {
  const catalogue = templateModelsFixture()
  const saved = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA, claude: process.env.E2B_CLAUDE_TEMPLATE, codex: process.env.E2B_CODEX_TEMPLATE }
  process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.invalid/mikka'
  process.env.MIKKA_CLOUD_WORKER_SHA = catalogue.sha
  process.env.E2B_CLAUDE_TEMPLATE = 'claude'
  process.env.E2B_CODEX_TEMPLATE = 'codex'
  const machines = await import('../../lib/cloud-computer/thread-machines')
  const { factoryAutomaticRuntime } = await import('../../lib/factory/automatic-dispatch')
  const realPark = factoryAutomaticRuntime.park
  const realEnqueue = factoryAutomaticRuntime.enqueue
  factoryAutomaticRuntime.enqueue = async (database, actor, previousRunId, runId) => {
    await (await import('../../lib/factory/cloud-stage-handoff')).handoffFactoryCloudStage(database, actor, previousRunId, runId)
  }
  factoryAutomaticRuntime.park = (database, actor, runId) => machines.parkThreadMachine(database, actor, runId, async () => {}, async () => null)
  const real = { ...machines.threadMachineProvider }
  const credentials = new Map<string, string>()
  const sandbox = (sandboxId: string) => {
    let handoff: { deviceId: string; credential: string } | undefined
    return {
      sandboxId,
      files: {
        read: async () => catalogue.sha,
        write: async (path: string, body: string) => {
          // The handoff alone cannot register a worker that has not started.
          if (!/^\/run\/mikka-viewer\/thread-[a-f0-9-]+\.json$/.test(path)) return
          const { deviceId, credential } = JSON.parse(body) as { deviceId: string; credential: string }
          handoff = { deviceId, credential }
          credentials.set(deviceId, credential)
        },
      },
      commands: { run: async (command: string) => {
        // Desktop/Git/runtime commands cannot impersonate an authenticated worker.
        if (command.includes(CLOUD_WORKER_COMMAND)) {
          if (!handoff) throw new Error('Fixture worker started without a bootstrap')
          const { deviceId, credential } = handoff
          const used = await pool.query('UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL RETURNING id', [deviceId, createHash('sha256').update(credential).digest('hex')])
          if (used.rowCount !== 1) throw new Error('Fixture worker credential unavailable')
          await pool.query('UPDATE devices SET "lastSeenAt"=clock_timestamp(),enabled=true,harnesses=$2 WHERE id=$1', [deviceId, JSON.stringify(harnesses)])
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      } },
    }
  }
  Object.assign(machines.threadMachineProvider, {
    connect: async (sandboxId: string) => sandbox(sandboxId),
    create: async (_snapshot: string, operationId: string) => sandbox(`sandbox-${operationId}`),
    kill: async () => {},
  })
  return {
    enqueueDurable: realEnqueue,
    /** Provisions a queued cloud run's thread machine; returns its device and the worker's device token. */
    async start(actor: { userId: string; workspaceId: string }, runId: string) {
      await machines.ensureThreadMachine(pool, actor, runId)
      const { deviceId } = (await pool.query<{ deviceId: string }>('SELECT "deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
      return { deviceId, token: credentials.get(deviceId)! }
    },
    restore() {
      factoryAutomaticRuntime.park = realPark
      factoryAutomaticRuntime.enqueue = realEnqueue
      Object.assign(machines.threadMachineProvider, real)
      for (const [name, value] of [['MIKKA_CLOUD_WORKER_URL', saved.url], ['MIKKA_CLOUD_WORKER_SHA', saved.sha], ['E2B_CLAUDE_TEMPLATE', saved.claude], ['E2B_CODEX_TEMPLATE', saved.codex]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value
      }
      catalogue.restore()
    },
  }
}
