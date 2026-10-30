import 'server-only'
import { eq } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db } from '@/lib/db'
import { agentRuns, agents, oauthClients, type ArtifactKind } from '@/lib/db/schema'
import { submitArtifact, type ArtifactSubmitter } from '@/lib/artifacts/store'
import { withBasePath } from '@/lib/base-path'
import { runBotName } from '@/lib/run-bot-name'
import { maskForRun } from '@/lib/secrets/runtime'

// submit_artifact, the one way any harness hands a document or web page to
// Mikka. From a run it is the run's artifact, by the run's agent; from an
// agent signed in with OAuth it belongs to the person, by that client.

export interface SubmitInput { title: string; kind: ArtifactKind; content: string; artifactId?: string }

/** The submitter for a run token: the run's agent. */
export async function runSubmitter(run: { id: string; userId: string; botId?: string | null; issueId: string | null }): Promise<ArtifactSubmitter> {
  const [row] = await db.select({ name: runBotName }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(eq(agentRuns.id, run.id)).limit(1)
  return { userId: run.userId, botId: run.botId ?? null, runId: run.id, issueId: run.issueId, authorName: row?.name ?? 'Coordinator' }
}

/** The submitter for an OAuth token: the person, by the client's registered name. */
export async function oauthSubmitter(userId: string, authInfo: AuthInfo | undefined): Promise<ArtifactSubmitter> {
  const clientId = authInfo?.clientId
  const [row] = clientId ? await db.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1) : []
  return { userId, runId: null, issueId: null, authorName: row?.name?.trim() || 'Mikka' }
}

export async function submit(submitter: ArtifactSubmitter, input: SubmitInput) {
  // 4e2 item 4: run artifacts (title + content) are masked with the run's secret set.
  const result = await submitArtifact(submitter, submitter.runId ? { ...input, ...await maskForRun(submitter.runId, { title: input.title, content: input.content }) } : input)
  if ('error' in result) return result
  return { ...result, note: 'Handed over. The person sees it as a card in their chat. To change it, call submit_artifact again with this artifactId; that makes the next version.', path: withBasePath(`/api/artifacts/${result.artifactId}/versions/${result.version}/download`) }
}
