import { runCredentialCleanup } from './credential-cleanup'
import { parseLinearWebhookRequest, verifyBearer } from '@/lib/linear-sync/webhook'

const WEBHOOK_PATH = '/mikka/api/webhooks/linear'
const CRON_PATH = '/mikka/api/cron/linear-sync'

export interface Env {
  HYPERDRIVE?: { connectionString: string }
  CRON_SECRET?: string
  CREDENTIAL_CLEANUP_ENABLED?: string
  LINEAR_CLIENT_ID?: string
  LINEAR_CLIENT_SECRET?: string
  LINEAR_TOKEN_ENCRYPTION_KEY?: string
  LINEAR_WEBHOOK_SECRET?: string
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
}

interface WorkerSchedule {
  cron: string
}

type SyncRuntime = Promise<{
  db: typeof import('@/lib/db').db
  createRequestDatabaseScope: typeof import('@/lib/db').createRequestDatabaseScope
  linearSyncInbox: typeof import('@/lib/db/schema').linearSyncInbox
  processLinearInboxDelivery: typeof import('@/lib/linear-sync/worker').processLinearInboxDelivery
  processLinearSyncBatch: typeof import('@/lib/linear-sync/worker').processLinearSyncBatch
}>

let syncRuntime: SyncRuntime | undefined

function syncConfigured(env: Env) {
  return Boolean(
    env.HYPERDRIVE?.connectionString &&
    env.LINEAR_CLIENT_ID &&
    env.LINEAR_CLIENT_SECRET &&
    /^[a-f\d]{64}$/i.test(env.LINEAR_TOKEN_ENCRYPTION_KEY ?? ''),
  )
}

function loadSyncRuntime(env: Env) {
  if (!syncConfigured(env)) throw new Error('Linear sync is not configured')
  process.env.MIKKA_DATABASE_URL = env.HYPERDRIVE!.connectionString
  process.env.LINEAR_CLIENT_ID = env.LINEAR_CLIENT_ID!
  process.env.LINEAR_CLIENT_SECRET = env.LINEAR_CLIENT_SECRET!
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY = env.LINEAR_TOKEN_ENCRYPTION_KEY!
  syncRuntime ??= Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/linear-sync/worker'),
  ]).then(([database, schema, worker]) => ({
    db: database.db,
    createRequestDatabaseScope: database.createRequestDatabaseScope,
    linearSyncInbox: schema.linearSyncInbox,
    processLinearInboxDelivery: worker.processLinearInboxDelivery,
    processLinearSyncBatch: worker.processLinearSyncBatch,
  }))
  return syncRuntime
}

async function withRequestDatabase<T>(runtime: Awaited<SyncRuntime>, connectionString: string, callback: () => T) {
  const scope = runtime.createRequestDatabaseScope(connectionString)
  try {
    return await scope.run(callback)
  } finally {
    await scope.close()
  }
}

async function webhook(request: Request, env: Env, ctx: WorkerContext) {
  const parsed = await parseLinearWebhookRequest(request, env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  if ('ignored' in parsed) return new Response(null, { status: 200 })
  if (!syncConfigured(env)) return Response.json({ error: 'Linear sync is not configured' }, { status: 503 })

  try {
    const runtime = await loadSyncRuntime(env)
    const [saved] = await withRequestDatabase(runtime, env.HYPERDRIVE!.connectionString, () => runtime.db.insert(runtime.linearSyncInbox).values({
      deliveryId: parsed.deliveryId,
      organizationId: parsed.organizationId,
      eventType: parsed.eventType,
      payload: parsed.payload,
    }).onConflictDoNothing().returning({ deliveryId: runtime.linearSyncInbox.deliveryId }))
    if (saved) {
      ctx.waitUntil(withRequestDatabase(runtime, env.HYPERDRIVE!.connectionString, () => runtime.processLinearInboxDelivery(saved.deliveryId)).catch(() => {
        console.error('Linear webhook processing failed; the queued delivery will be retried')
      }))
    }
    return new Response(null, { status: 200 })
  } catch {
    return Response.json({ error: 'Could not queue Linear webhook' }, { status: 503 })
  }
}

async function cron(request: Request, env: Env) {
  if (!env.CRON_SECRET) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), env.CRON_SECRET)) return new Response(null, { status: 401 })
  if (!syncConfigured(env)) return Response.json({ error: 'Linear sync is not configured' }, { status: 503 })
  try {
    const runtime = await loadSyncRuntime(env)
    return Response.json(await withRequestDatabase(runtime, env.HYPERDRIVE!.connectionString, () => runtime.processLinearSyncBatch()))
  } catch {
    return Response.json({ error: 'Linear sync batch could not run' }, { status: 503 })
  }
}

export async function handleRequest(request: Request, env: Env, ctx: WorkerContext) {
  const path = new URL(request.url).pathname
  if (path === WEBHOOK_PATH && request.method === 'POST') return webhook(request, env, ctx)
  if (path === CRON_PATH && request.method === 'GET') return cron(request, env)
  return new Response(null, { status: 404 })
}

export function createScheduledHandler(loadRuntime = loadSyncRuntime) {
  return function scheduled(controller: WorkerSchedule, env: Env, ctx: WorkerContext) {
    if (controller.cron === '* * * * *') {
      // Rejections remain visible to the scheduler. Next tick retries durable
      // tombstones; never log provider responses or follow redirects with auth.
      if (env.CREDENTIAL_CLEANUP_ENABLED === '1') ctx.waitUntil(runCredentialCleanup(env))
      return
    }
    if (!env.CRON_SECRET || !syncConfigured(env)) return
    ctx.waitUntil(loadRuntime(env).then(runtime => withRequestDatabase(runtime, env.HYPERDRIVE!.connectionString, () => runtime.processLinearSyncBatch())).catch(() => {
      console.error('Linear sync scheduled batch failed')
    }))
  }
}

export default { fetch: handleRequest, scheduled: createScheduledHandler() }
