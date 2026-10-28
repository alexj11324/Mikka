import { z } from 'zod'
import { OperationError } from './write-error'

const decision = z.enum(['allow', 'ask', 'deny'])
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), decision)

/** Resolve only host-owned permission configuration. Absence means ask. Invalid
 * data is unavailable, never allow. Each layer can only narrow the decision. */
export function resolveWritePermission(action: string, layers: readonly unknown[]): 'allow' | 'ask' | 'deny' {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(action) || !layers.length) throw new OperationError('writePolicyUnavailable')
  let result: 'allow' | 'ask' | 'deny' = 'allow'
  for (const raw of layers) {
    const parsed = settings.safeParse(raw)
    if (!parsed.success) throw new OperationError('writePolicyUnavailable')
    const choice = parsed.data[action] ?? 'ask'
    if (choice === 'deny') return 'deny'
    if (choice === 'ask') result = 'ask'
  }
  return result
}
