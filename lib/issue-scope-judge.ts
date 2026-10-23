import 'server-only'
import { and, desc, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, linearTeamSyncs } from '@/lib/db/schema'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { SCOPE_EXAMPLE_LIMIT, scopeFromProbability, scopeQuestions, scopeState } from '@/lib/issue-scope'
import { processLinearIssueOutbox } from '@/lib/linear-sync/worker'
import { tiptapToText } from '@/lib/tiptap-text'

/**
 * Asks the decision model whether a new issue is a workspace issue (MIK-47).
 * Only a confident yes moves it to the workspace, which queues it for Linear.
 * Without a Linear team, a set scope, or an answer, it stays personal. Call it
 * after the issue is committed; never throws.
 */
export async function judgeIssueScope(issueId: string, source: string): Promise<void> {
  try {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1)
    if (!issue || issue.scopeSetBy === 'user' || issue.scope === 'workspace' || readIssueMetadata(issue.content).deletedAt) return
    // Nothing to sync to, so no reason to spend a call.
    const [team] = await db.select({ key: linearTeamSyncs.linearTeamKey, name: linearTeamSyncs.linearTeamName }).from(linearTeamSyncs)
      .where(and(eq(linearTeamSyncs.ownerId, issue.userId), eq(linearTeamSyncs.active, true))).limit(1)
    if (!team) return
    const examples = await db.select({ title: issues.title, scope: issues.scope }).from(issues)
      .where(and(eq(issues.userId, issue.userId), eq(issues.scopeSetBy, 'user'), ne(issues.id, issue.id)))
      .orderBy(desc(issues.updatedAt)).limit(SCOPE_EXAMPLE_LIMIT)
    const state = scopeState({ title: issue.title, description: tiptapToText(issue.content), source, linearTeam: team, examples })
    const answer = (await decide('issue-scope', decisionInput(state), scopeQuestions()))?.get('workspace')
    if (answer?.type !== 'predicate') return
    const scope = scopeFromProbability(answer.probability)
    // Only while the agent still owns the decision: a click in the meantime wins.
    const [moved] = await db.update(issues).set({ scope, scopeConfidence: answer.probability })
      .where(and(eq(issues.id, issue.id), eq(issues.scopeSetBy, 'agent'), eq(issues.scope, 'personal'))).returning({ id: issues.id })
    if (moved && scope === 'workspace') await processLinearIssueOutbox(issue.id)
  } catch (error) {
    console.error('Issue scope judgment failed', error instanceof Error ? error.message : error)
  }
}
