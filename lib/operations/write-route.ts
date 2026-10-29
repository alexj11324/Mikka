import { approvedWriteHandler } from './write-http'
export { PERSONAL_WRITES_ENABLED } from './write-feature'

type WriteAuth = Parameters<typeof approvedWriteHandler>[0]
type WriteOperations = Parameters<typeof approvedWriteHandler>[1]
type WriteDiscovery = Parameters<typeof approvedWriteHandler>[2]

/** The trusted deployment gate is checked before loading runtime services.
 * An admitted deployment still uses the same identity, permission and ledger path. */

export function createPersonalWriteRoute(dependencies: {
  enabled: () => boolean
  load: () => Promise<{ auth: WriteAuth; operations: WriteOperations; discovery?: WriteDiscovery }>
}) {
  return async (request: Request): Promise<Response> => {
    if (!dependencies.enabled()) return Response.json({ error: 'approvedWritesDisabled' }, { status: 503, headers: { 'cache-control': 'no-store' } })
    try {
      const { auth, operations, discovery } = await dependencies.load()
      return await approvedWriteHandler(auth, operations, discovery)(request)
    } catch {
      // Loading the runtime can fail before the HTTP service is constructed.
      // Do not leak environment diagnostics or report a definitive no-effect.
      return Response.json({ error: 'writeServiceUnavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
    }
  }
}
