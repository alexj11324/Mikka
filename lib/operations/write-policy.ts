import { z } from 'zod'
import { OperationError } from './write-error'
import { permissionDecision } from './permission-precedence'

const decision = z.enum(['allow', 'ask', 'deny'])
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), decision)

/** The default for an action no layer names: allow unless the Decisions API
 * judged the exact call destructive (decision 2026-10-31, R-77). A caller
 * without a judgment gets ask. */
export type WriteFallback = 'allow' | 'ask'

/** The workspace entry is the decision. There is no agent/Bot choice to narrow:
 * absence falls back, a malformed layer is unavailable (never allow), and deny
 * beats ask beats allow inside the workspace layer
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
