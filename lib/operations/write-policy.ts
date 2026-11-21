import { z } from 'zod'
import { OperationError } from './write-error'
import { permissionDecision } from './permission-precedence'

// Numeric versions are pinned receipts for operations created before the settings change.
export const DIRECT_APP_WRITE_VERSION = 'direct'
export const writePolicyVersion = z.union([z.literal(DIRECT_APP_WRITE_VERSION), z.string().regex(/^\d+(?::\d+)?$/)])

const decision = z.enum(['allow', 'ask', 'deny'])
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), decision)

/** The default stored with an older policy-bound operation. */
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
