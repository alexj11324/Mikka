import type { Pool } from 'pg'
import { z } from 'zod'
import { executionIdentitySchema } from '../execution-identity'
import type { WorkerDefinitionSnapshot } from '../agent-kit/worker'
import { anonymousStartupHint, firstAnonymousTask } from '../computer/anonymous-startup-hint'

export const bootstrapEvidenceQuery = z.object({
  bootstrap: z.literal('1'), deviceId: z.uuid(), workspaceId: z.uuid(),
  bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type Input = z.infer<typeof bootstrapEvidenceQuery>
type Row = Parameters<typeof firstAnonymousTask>[1] & {
  id: string; userId: string; botId: string; deviceId: string; kind: string
  repository: string | null; definition: WorkerDefinitionSnapshot | null
}

/** Only the explicit owner evidence view performs this read. No prompt, token,
 * assignment or model credential is loaded or returned. The hint is speculative:
 * the worker must still obtain its one normal fresh claim before any adoption. */
export async function readRunBootstrapEvidence(pool: Pick<Pool, 'query'>, userId: string, runId: string, input: Input) {
  const { rows: [run] } = await pool.query<Row>(`
    SELECT r.id,r."userId",r."botId",r."deviceId",r.kind,r.status,r.attempt,r."startedAt",r."sessionId",
      r."deviceTokenId",r."retryOf",r."continuesRunId",r."questionContinuation",r."stopRequestedAt",repo."repoPath" AS repository,
      jsonb_build_object(
        'harness',r."agentDefinition"->'harness','modelSource',r."agentDefinition"->'modelSource',
        'cliModelSelection',r."agentDefinition"->'cliModelSelection','model',r."agentDefinition"->'model',
        'subscription',r."agentDefinition"->'subscription','readOnly',r."agentDefinition"->'readOnly',
        'policyCeiling',r."agentDefinition"->'policyCeiling',
        'customMcp',coalesce(r."agentDefinition"->'customMcp'<>'null'::jsonb,false),
        'repositoryAdmission',coalesce(r."agentDefinition"->'repositoryAdmission'<>'null'::jsonb,false),
        'agentProfile',CASE WHEN r."agentDefinition"#>'{agentProfile,effort}' IS NOT NULL
          THEN jsonb_build_object('effort',r."agentDefinition"#>'{agentProfile,effort}') ELSE NULL END,
        'modelDispatch',CASE WHEN r."agentDefinition"#>'{modelDispatch,routing,effort}' IS NOT NULL
          THEN jsonb_build_object('routing',jsonb_build_object('effort',r."agentDefinition"#>'{modelDispatch,routing,effort}')) ELSE NULL END,
        'mailbox',jsonb_build_object('tools',coalesce(r."agentDefinition"#>'{mailbox,tools}','[]'::jsonb)),
        'executionIdentity',r."agentDefinition"->'executionIdentity') AS definition
    FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled AND d."removedAt" IS NULL
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."deviceId"=d.id AND repo."userId"=$2
    JOIN bots b ON b.id=r."botId" AND b."ownerId"=$2 AND b."workspaceId"=$4 AND b."archivedAt" IS NULL
    WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3`, [runId, userId, input.deviceId, input.workspaceId])
  if (!run || run.id !== runId || run.userId !== userId || run.deviceId !== input.deviceId ||
    run.definition?.readOnly !== true || !firstAnonymousTask({ created: true, refresh: false, retained: false, question: false }, run)) return null
  const identity = executionIdentitySchema.safeParse(run.definition.executionIdentity)
  if (!identity.success || identity.data.requester !== userId || identity.data.executionPrincipal !== userId ||
    identity.data.outputOwner !== userId || identity.data.workspaceId !== input.workspaceId || identity.data.botId !== run.botId ||
    identity.data.resourceBindings.filter(row => row.kind === 'device').length !== 1 ||
    !identity.data.resourceBindings.some(row => row.kind === 'device' && row.id === input.deviceId && row.ownerId === userId && row.access === 'owner')) return null
  const harness = run.definition.harness
  const encoded = anonymousStartupHint({ runId, bootstrap: { sha256: input.bootstrapSha256 }, kind: run.kind, repository: run.repository,
    userId, botId: run.botId, definition: run.definition, freshTask: true, diagnostics: true })
  if (!encoded) return null
  return { version: 1 as const, authority: 'none' as const, deviceId: input.deviceId, workspaceId: input.workspaceId,
    harness, hint: JSON.parse(encoded) as unknown }
}
