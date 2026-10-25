'use server'

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { db } from '@/lib/db'
import { issuePrefixes, linearTeamSyncs } from '@/lib/db/schema'
import { defaultPersonalPrefix, normalizePersonalPrefix, prefixCollides, resolvePersonalPrefix } from '@/lib/task-identifier'

async function linearTeamKeys(userId: string) {
  return (await db.select({ key: linearTeamSyncs.linearTeamKey }).from(linearTeamSyncs).where(eq(linearTeamSyncs.ownerId, userId))).map(row => row.key)
}

/** The personal task prefix (MIK-46): what personal tasks show now, and the email default. */
export async function getIssuePrefixState() {
  const user = await requireUser()
  const [[saved], teamKeys] = await Promise.all([
    db.select({ prefix: issuePrefixes.prefix }).from(issuePrefixes).where(eq(issuePrefixes.userId, user.id)).limit(1),
    linearTeamKeys(user.id),
  ])
  const prefix = resolvePersonalPrefix({ saved: saved?.prefix, email: user.email, linearTeamKeys: teamKeys })
  return { prefix, saved: saved?.prefix ?? null, suggested: defaultPersonalPrefix(user.email), teamKeys }
}

export async function saveIssuePrefix(input: { prefix: string }) {
  const user = await requireUser()
  const parsed = z.object({ prefix: z.string().max(20) }).safeParse(input)
  const prefix = parsed.success ? normalizePersonalPrefix(parsed.data.prefix) : null
  if (!prefix) return { error: 'issuePrefixInvalid' as const }
  if (prefixCollides(prefix, await linearTeamKeys(user.id))) return { error: 'issuePrefixTaken' as const }
  await db.insert(issuePrefixes).values({ userId: user.id, prefix, updatedAt: new Date() })
    .onConflictDoUpdate({ target: issuePrefixes.userId, set: { prefix, updatedAt: new Date() } })
  return { success: true as const, prefix }
}
