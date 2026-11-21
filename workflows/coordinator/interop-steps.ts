import type { InteropToolId } from '@/lib/interop/tool-schemas'
import type { NativeToolScope } from './tool-scope'

/**
 * A Bot's interop tool call (decision 2026-11-19-2200). The Bot acts with its
 * owner's identity and its own grants, pinned to the Bot's Workspace; the
 * target must still pass the ACL. A refusal is a tool result, not a retry.
 */
export async function interopTool(userId: string, botId: string, name: InteropToolId, input: unknown, scope?: NativeToolScope) {
  'use step'
  const { assertNativeToolScope } = await import('./tool-scope')
  await assertNativeToolScope(userId, scope)
  const [{ botPrincipal }, { interopFailure, runInteropTool }, { withRunSpan }] = await Promise.all([
    import('@/lib/interop/principal'), import('@/lib/interop/tools'), import('@/lib/tracing/context')])
  return withRunSpan('coordinator.tool', {}, async () => {
    let principal
    try { principal = await botPrincipal(userId, botId) }
    catch (error) { return interopFailure(error) }
    return runInteropTool(principal, name, input)
  })
}
