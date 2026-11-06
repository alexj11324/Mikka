import { z } from 'zod'

/** Names for an execution identity's references (lib/execution-identity-labels.ts); allowlisted for the browser. */
export const executionIdentityLabelsSchema = z.object({
  workspace: z.object({ name: z.string().max(200) }).nullable(),
  people: z.record(z.string(), z.object({ name: z.string().max(200), image: z.string().max(200_000).nullable(), you: z.boolean() })),
  devices: z.record(z.string(), z.object({ name: z.string().max(200), kind: z.enum(['cloud', 'laptop', 'server']) })),
  subscriptions: z.record(z.string(), z.object({ provider: z.enum(['claude', 'codex']), account: z.string().max(320).nullable(), mine: z.boolean() })),
  apiKeys: z.record(z.string(), z.object({ provider: z.string().max(40), name: z.string().max(200).nullable(), last4: z.string().max(8).nullable(), mine: z.boolean() })),
  mcp: z.record(z.string(), z.object({ name: z.string().max(200) })),
  e2b: z.object({ last4: z.string().max(8) }).nullable(),
})
export type ExecutionIdentityLabels = z.infer<typeof executionIdentityLabelsSchema>

export const EMPTY_LABELS: ExecutionIdentityLabels = { workspace: null, people: {}, devices: {}, subscriptions: {}, apiKeys: {}, mcp: {}, e2b: null }

type Role = 'requester' | 'botOwner' | 'executionPrincipal' | 'outputOwner'
export const ROLES: readonly Role[] = ['requester', 'botOwner', 'executionPrincipal', 'outputOwner']

/**
 * The four roles grouped by person, in role order, so one person who holds all
 * four is one row (Alex, 2026-11-06). A role with no person is left out.
 */
export function rolesByPerson(identity: Record<Role, string | null>): { personId: string; roles: Role[] }[] {
  const rows: { personId: string; roles: Role[] }[] = []
  for (const role of ROLES) {
    const personId = identity[role]
    if (!personId) continue
    const row = rows.find(item => item.personId === personId)
    if (row) row.roles.push(role)
    else rows.push({ personId, roles: [role] })
  }
  return rows
}
