'use server'

import { z } from 'zod'
import { runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/issue-access'
import { readPreferences, savePreferences } from '@/lib/preferences'
import { clearFacts, correctFact } from '@/lib/profile/store'
import { addMemoryFact, mayCorrectMemoryFact, readMemoryView, removeMemoryFact, reviewMemoryFact, setMemoryFactScope, undoMemoryFact } from '@/lib/profile/memory'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { USER_FACT_KINDS } from '@/lib/profile/kinds'

// 记忆 (R-73): the signed-in person's own facts only; nothing here takes
// another person. Scope uses the authenticated workspace selection and checks
// current membership. The switch is user_preferences."memoryEnabled",
// the same one mobile Settings writes (app/api/mobile/preferences).

/** The switch, the facts shown (at most 500) and how many active facts there are in all. */
export async function getMemory() {
  const user = await requireUser()
  const [preferences, context] = await Promise.all([readPreferences(user.id), loadWorkspaceContext(undefined, user)])
  return { enabled: preferences.memoryEnabled, ...await readMemoryView(user.id, context.workspace.id, context.choices) }
}

export async function setMemory(enabled: boolean) {
  const user = await requireUser()
  await savePreferences(user.id, { memoryEnabled: z.boolean().parse(enabled) })
}

/** 删除全部记忆: removes every fact (soft delete, as removeFact) and returns how many active ones went. */
export async function clearMemory(): Promise<ActionResult<{ removed: number }>> {
  return runAction(async () => {
    const user = await requireUser()
    return { removed: await clearFacts(user.id) }
  })
}

export async function removeFact(id: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  return removeMemoryFact(user.id, context.workspace.id, z.uuid().parse(id))
}

export async function updateFact(id: string, subject: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  const factId = z.uuid().parse(id)
  const normalized = z.string().trim().min(1).max(200).parse(subject)
  if (!await mayCorrectMemoryFact(user.id, context.workspace.id, factId, normalized)) return false
  return correctFact(user.id, factId, normalized)
}

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global'), ids: z.tuple([]) }),
  z.object({ kind: z.literal('workspaces'), ids: z.array(z.uuid()).min(1).max(50) }),
  z.object({ kind: z.literal('projects'), ids: z.array(z.uuid()).min(1).max(50) }),
])

/** Idempotency key is required for a manual insert; the userId is always session-derived. */
export async function addFact(input: { requestId: string; kind: (typeof USER_FACT_KINDS)[number]; subject: string; scope?: import('@/lib/profile/memory').MemoryScope }) {
  const user = await requireUser()
  const parsed = z.object({
    requestId: z.uuid(), kind: z.enum(USER_FACT_KINDS),
    subject: z.string().trim().min(1).max(200),
    scope: scopeSchema.default({ kind: 'global', ids: [] }),
  }).parse(input)
  const context = await loadWorkspaceContext(undefined, user)
  return addMemoryFact(user.id, context.workspace.id, parsed)
}

export async function reviewFact(id: string, decision: 'approve' | 'reject') {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  return reviewMemoryFact(user.id, context.workspace.id, z.uuid().parse(id), z.enum(['approve', 'reject']).parse(decision))
}

export async function setFactScope(id: string, scope: import('@/lib/profile/memory').MemoryScope) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  return setMemoryFactScope(user.id, context.workspace.id, z.uuid().parse(id), scopeSchema.parse(scope))
}

export async function undoRemoveFact(id: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(undefined, user)
  return undoMemoryFact(user.id, context.workspace.id, z.uuid().parse(id))
}
