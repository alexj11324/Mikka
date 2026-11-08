import { compactRunFailure, readRunFailure } from '@mikka/protocol/run-failure'

export type CompactRunFailure = NonNullable<ReturnType<typeof compactRunFailure>>

/** Historical nulls and malformed diagnostics remain compatible with lists. */
export function readCompactRunFailure(value: unknown): CompactRunFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return compactRunFailure(readRunFailure({ ...value, causes: [] }))
}
