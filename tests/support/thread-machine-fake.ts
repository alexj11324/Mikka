// A cloud run's own thread machine, as production provisions it, with only E2B
// replaced: the real ensureThreadMachine records the sandbox, the thread device
// and its repository, and moves the queued run onto that device. The fake
// sandbox's worker "registers" when it receives its bootstrap file, reporting
// the given harnesses (a task machine reports no computer broker).
import type { Pool } from 'pg'

type Harness = Record<string, unknown>

export async function fakeThreadMachines(pool: Pool, harnesses: Harness[]) {
  const saved = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA, claude: process.env.E2B_CLAUDE_TEMPLATE, codex: process.env.E2B_CODEX_TEMPLATE }
  process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.invalid/mikka'
  process.env.MIKKA_CLOUD_WORKER_SHA = 'fixture-worker-sha'
  process.env.E2B_CLAUDE_TEMPLATE = 'claude-template-fixture'
  process.env.E2B_CODEX_TEMPLATE = 'codex-template-fixture'
  const machines = await import('../../lib/cloud-computer/thread-machines')
  const real = { ...machines.threadMachineProvider }
  const credentials = new Map<string, string>()
  const sandbox = (sandboxId: string) => ({
    sandboxId,
    files: {
      read: async () => 'fixture-worker-sha',
      write: async (_path: string, body: string) => {
        const { deviceId, credential } = JSON.parse(body) as { deviceId: string; credential: string }
        credentials.set(deviceId, credential)
        await pool.query('UPDATE devices SET "lastSeenAt"=now(),enabled=true,harnesses=$2 WHERE id=$1', [deviceId, JSON.stringify(harnesses)])
      },
    },
    commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  })
  Object.assign(machines.threadMachineProvider, {
    snapshot: async () => 'snapshot-fixture',
    connect: async (sandboxId: string) => sandbox(sandboxId),
    create: async (_snapshot: string, operationId: string) => sandbox(`sandbox-${operationId}`),
    kill: async () => {},
  })
  return {
    /** Provisions a queued cloud run's thread machine; returns its device and the worker's device token. */
    async start(actor: { userId: string; workspaceId: string }, runId: string) {
      await machines.ensureThreadMachine(pool, actor, runId)
      const { deviceId } = (await pool.query<{ deviceId: string }>('SELECT "deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
      return { deviceId, token: credentials.get(deviceId)! }
    },
    restore() {
      Object.assign(machines.threadMachineProvider, real)
      for (const [name, value] of [['MIKKA_CLOUD_WORKER_URL', saved.url], ['MIKKA_CLOUD_WORKER_SHA', saved.sha], ['E2B_CLAUDE_TEMPLATE', saved.claude], ['E2B_CODEX_TEMPLATE', saved.codex]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value
      }
    },
  }
}
