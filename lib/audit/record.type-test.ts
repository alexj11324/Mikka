// Type-level guard, checked by `pnpm typecheck`: recordAuditSafe takes no executor,
// so it can never be handed a caller's transaction.
import type { recordAuditSafe } from './record'

type SafeParams = Parameters<typeof recordAuditSafe>
type Assert<T extends true> = T
export type SafeTakesOnlyTheEvent = Assert<SafeParams['length'] extends 1 ? true : false>
declare const tx: { insert: unknown }
declare const safe: typeof recordAuditSafe
// @ts-expect-error a transaction is not an AuditEvent, and there is no executor slot
void (() => safe(tx, { workspaceId: '', actor: { type: 'system' }, action: 'auth.signed_in' }))
