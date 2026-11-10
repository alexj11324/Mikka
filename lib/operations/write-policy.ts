import { z } from 'zod'
import { OperationError } from './write-error'
import { permissionDecision } from './permission-precedence'

const decision = z.enum(['allow', 'ask', 'deny'])
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), decision)

/** The default for an action no layer names: allow unless the Decisions API
 * judged the exact call destructive (decision 2026-10-31, R-77). A caller
 * without a judgment gets ask. */
export type WriteFallback = 'allow' | 'ask'

/** Resolve only host-owned permission configuration. Absence from every layer
 * means the tool's fallback; a layer that does not name the action does not
 * inject one. Invalid data is unavailable, never allow. Restrictive wins:
 * deny > ask > allow, the same rule as the app tool path
 * (lib/operations/permission-precedence.ts). */
export function resolveWritePermission(action: string, layers: readonly unknown[], fallback: WriteFallback = 'ask'): 'allow' | 'ask' | 'deny' {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(action) || !layers.length) throw new OperationError('writePolicyUnavailable')
  const choices: Array<'allow' | 'ask' | 'deny'> = []
  for (const raw of layers) {
    const parsed = settings.safeParse(raw)
    if (!parsed.success) throw new OperationError('writePolicyUnavailable')
    if (Object.hasOwn(parsed.data, action)) choices.push(parsed.data[action])
  }
  return permissionDecision(choices) ?? fallback
}

/** The workspace's layer. A workspace deny or ask applies to every Bot; there is
 * no Bot layer to narrow it. */
export function resolveScopedWritePermission(action: string, agent: unknown, workspace: unknown, fallback: WriteFallback = 'ask'): 'allow' | 'ask' | 'deny' {
  const parsed = settings.safeParse(workspace)
  if (!parsed.success) throw new OperationError('writePolicyUnavailable')
  return resolveWritePermission(action, [agent, parsed.data], fallback)
}
