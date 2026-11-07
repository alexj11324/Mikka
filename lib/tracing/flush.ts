// Exporters register once. Request/Workflow completion flushes their in-memory
// queues through waitUntil; no exporter is awaited on the business path.
const key = Symbol.for('mikka.telemetry.flush')
type Flush = () => Promise<unknown>
function hooks(): Set<Flush> {
  const state = globalThis as Record<symbol, Set<Flush> | undefined>
  return state[key] ??= new Set<Flush>()
}

export function registerTelemetryFlush(flush: Flush): () => void {
  hooks().add(flush)
  return () => { hooks().delete(flush) }
}

export async function flushTelemetry(): Promise<void> {
  await Promise.allSettled([...hooks()].map(flush => Promise.resolve().then(flush)))
}
