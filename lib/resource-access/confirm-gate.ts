import { ActionFailureError } from '../action-error'
import type { AudienceChange } from './audience'

/**
 * The confirmAccess gate (ALE-26). A relation edit that changes who can read a
 * resource writes nothing until the caller confirms it; this module holds that
 * ordering so it is provable without a database.
 *
 * Nothing here imports a database or auth module: confirm-access.ts supplies
 * the audience reads, and its caller supplies the write.
 */

export type AccessChangeSummary = { tasks: number; readers: number }

/**
 * A refusal when the edit changes an audience and the caller has not confirmed,
 * `null` when it may proceed. `readers` counts the distinct accounts that gain
 * or lose access, so the person is told what the edit does before accepting it.
 */
export function accessChangeRefusal(changes: Iterable<AudienceChange>, confirmAccess: boolean): AccessChangeSummary | null {
  if (confirmAccess) return null
  const changed = [...changes].filter(change => change.changed)
  if (!changed.length) return null
  return {
    tasks: changed.length,
    readers: new Set(changed.flatMap(change => change.removed.length ? change.removed : change.added)).size,
  }
}

/** Throws the confirmable refusal, so callers that cannot return a value still refuse. */
export function requireAccessConfirmation(changes: Iterable<AudienceChange>, confirmAccess: boolean): void {
  const refusal = accessChangeRefusal(changes, confirmAccess)
  if (refusal) throw new ActionFailureError('accessChangeConfirmationRequired', refusal, true)
}

/**
 * The whole handshake in one place: observe the audience the edit would leave,
 * refuse before writing when it changes and nobody confirmed, otherwise write.
 * The write is never reached on a refusal, which is what makes the edit free of
 * side effects.
 */
export async function withAccessConfirmation<T>(observe: () => Promise<Iterable<AudienceChange>>, confirmAccess: boolean, write: () => Promise<T>): Promise<T> {
  requireAccessConfirmation(await observe(), confirmAccess)
  return write()
}
