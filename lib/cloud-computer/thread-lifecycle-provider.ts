import 'server-only'
import { NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b'
import { e2bApiKey, withE2BErrors } from '@/lib/secrets/e2b-runtime'

const options = async (ownerId: string) => ({
  apiKey: await e2bApiKey(ownerId, 'Cloud runtime unavailable'),
  proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
  requestTimeoutMs: 15_000,
})

export type ThreadProviderInfo = { state: 'running' | 'paused' | 'missing'; endAt: number | null }
export type ThreadCreatedSandbox = { sandboxId: string; state: 'running' | 'paused'; startedAt: number; endAt: number | null }

/** Maintenance must never connect: E2B connect resumes a paused VM. These
 * control-plane operations observe or extend an already running machine. */
export const threadLifecycleProvider = {
  async findCreated(runId: string, workspaceId: string, operationId: string, ownerId: string): Promise<ThreadCreatedSandbox | null> {
    const metadata = { application: 'mikka-thread', workspaceId, runId, operationId }
    const pages = Sandbox.list({ ...await options(ownerId), limit: 2, query: { metadata, state: ['running', 'paused'] } })
    const found = await pages.nextItems()
    // An allocation is unique to the persisted operation. Ambiguous, partial
    // or mismatched results require reconciliation; none authorizes a kill.
    if (found.length > 1 || pages.hasNext || found.some(item => Object.entries(metadata).some(([key, value]) => item.metadata[key] !== value)))
      throw new Error('Thread allocation identity unavailable')
    const item = found[0]
    return item ? { sandboxId: item.sandboxId, state: item.state, startedAt: item.startedAt.getTime(),
      endAt: item.state === 'paused' ? null : item.endAt.getTime() } : null
  },
  async info(sandboxId: string, ownerId: string): Promise<ThreadProviderInfo> {
    try {
      const info = await Sandbox.getInfo(sandboxId, await options(ownerId))
      return { state: info.state === 'paused' ? 'paused' : 'running', endAt: info.state === 'paused' ? null : info.endAt.getTime() }
    } catch (error) {
      const status = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
      if (error instanceof SandboxNotFoundError || error instanceof NotFoundError || status === 404) return { state: 'missing', endAt: null }
      throw error
    }
  },
  async keepAlive(sandboxId: string, ownerId: string, timeoutMs: number): Promise<void> {
    const prepared = await options(ownerId)
    await withE2BErrors(ownerId, false, () => Sandbox.setTimeout(sandboxId, timeoutMs, prepared))
  },
}
