type SessionProjection = { data?: { user?: { id?: string }; session?: { id?: string } } | null; error?: unknown; isPending?: boolean; isRefetching?: boolean }
type SessionAtom = { subscribe(listener: (value: SessionProjection) => void): () => void }
let version = 0
let observedOwner: string | null | undefined

/** A request may outlive the account that issued it. This public identity
 * generation carries no cookie/session credential and adds no session read. */
export function getSessionOwnerVersion() { return version }

/** Better Auth remains the sole owner of cookie session state. Listen to its
 * settled identity changes without fabricating sessions or adding a timer. */
export function watchSessionOwner(atom: SessionAtom, changed: () => void) {
  let initialized = false
  let previous: string | null = null
  return atom.subscribe(value => {
    if (value.isPending || value.isRefetching || value.error) return
    const userId = value.data?.user?.id
    const sessionId = value.data?.session?.id
    if (value.data && (typeof userId !== 'string' || typeof sessionId !== 'string')) return
    const owner = value.data ? JSON.stringify([userId, sessionId]) : null
    if (observedOwner !== undefined && owner !== observedOwner) version++
    observedOwner = owner
    if (!initialized) { initialized = true; previous = owner; return }
    if (owner !== previous) { previous = owner; changed() }
  })
}
