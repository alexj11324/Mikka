// The profile's vocabulary (R-73, docs/design/proactive.md § 2.2), kept free
// of imports so 记忆 in the browser can read it without the database schema.

/** What a fact in a person's profile is about. */
export const USER_FACT_KINDS = ['interest', 'routine', 'place', 'subscription', 'deadline', 'tool', 'person', 'preference'] as const
export type UserFactKind = (typeof USER_FACT_KINDS)[number]
/** `dismissed`: the person said it is wrong; `deleted`: removed in 记忆, kept so it is not learnt again; `expired`: past its date or faded, revived if seen again. */
export const USER_FACT_STATES = ['active', 'dismissed', 'deleted', 'expired'] as const
export type UserFactState = (typeof USER_FACT_STATES)[number]

// Memory review, provenance and scope. Historical facts have no verified source.
export type MemorySourceKind = 'thread' | 'decision' | 'told' | 'file'
export type MemoryReviewStatus = 'approved' | 'pending'
export type MemoryScopeKind = 'global' | 'workspaces' | 'projects'
