'use server'

import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { readPreferences, savePreferences } from '@/lib/preferences'
import { correctFact, deleteFact, listFacts } from '@/lib/profile/store'

// 记忆 (R-73): the signed-in person's own facts only; nothing here takes
// another person or a workspace. The switch is user_preferences."memoryEnabled",
// the same one mobile Settings writes (app/api/mobile/preferences).

export async function getMemory() {
  const user = await requireUser()
  const [preferences, facts] = await Promise.all([readPreferences(user.id), listFacts(user.id)])
  return { enabled: preferences.memoryEnabled, facts: facts.map(fact => ({ id: fact.id, kind: fact.kind, subject: fact.subject, userEdited: fact.userEdited })) }
}

export async function setMemory(enabled: boolean) {
  const user = await requireUser()
  await savePreferences(user.id, { memoryEnabled: z.boolean().parse(enabled) })
}

export async function removeFact(id: string) {
  const user = await requireUser()
  return deleteFact(user.id, z.uuid().parse(id))
}

export async function updateFact(id: string, subject: string) {
  const user = await requireUser()
  return correctFact(user.id, z.uuid().parse(id), z.string().max(200).parse(subject))
}
