import 'server-only'
import { pool } from '@/lib/db'
import { orderCandidates } from '@/lib/model-order'
import type { BotModelMenu, BotModelMenuGroup } from '@/lib/bot-model-menu-view'
import { threadModelKey } from '@/lib/thread-model-choice'
import { withTaskWorkspace } from '@/lib/task-workspace'
import type { IssueReader } from '@/lib/issue-visibility'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'

/** The same model menu presentation, with candidates admitted by the coding harness catalogue. */
export async function threadModelMenu(reader: IssueReader, workspaceId: string, issueId: string, runId: string): Promise<BotModelMenu | null> {
  const ownerId = typeof reader === 'string' ? reader : reader.id
  return withTaskWorkspace(reader, workspaceId, () => readMenu(ownerId, workspaceId, issueId, runId))
}

async function readMenu(ownerId: string, workspaceId: string, issueId: string, runId: string): Promise<BotModelMenu | null> {
  const { rows: [run] } = await pool.query(`SELECT r."workspaceId", r.status, coalesce(r."agentDefinition"->>'harness', a.harness) AS harness,
    r."agentDefinition"->>'model' AS model, r."agentDefinition" #>> '{agentProfile,definition,model,mode}' AS "profileMode"
    FROM agent_runs r JOIN agents a ON a.id=r."agentId" WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND r."workspaceId"=$4
      AND r."deviceRepoId" IS NOT NULL AND (r."deviceId" IS NOT NULL OR EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=r."userId"))
      AND coalesce(r."questionContinuation"->>'requireSessionResume','false')<>'true'
      AND NOT EXISTS (SELECT 1 FROM factory_questions q WHERE q."originRunId"=r.id AND q."userId"=r."userId")`, [runId, ownerId, issueId, workspaceId])
  if (!run || !run.workspaceId || !['codex', 'claude_code'].includes(run.harness) ||
      UNFINISHED_RUN_STATUSES.some(s => s === run.status) || (run.profileMode && run.profileMode !== 'inherit')) return null
  const candidates = await orderCandidates(pool, { ownerId, workspaceId: run.workspaceId })
  const groups = new Map<string, BotModelMenuGroup>()
  for (const candidate of candidates) {
    if (candidate.harness !== run.harness) continue
    const source = candidate.source
    const sourceId = source.kind === 'subscription' ? source.connectionId : source.keyId
    const group: BotModelMenuGroup = groups.get(sourceId) ?? { kind: candidate.credentialOwnerId !== ownerId ? 'shared' : source.kind === 'subscription' ? 'subscription' : 'apiKey',
      provider: candidate.provider, credentialLabel: '…' + sourceId.slice(-6), options: [] }
    const id = threadModelKey(candidate)
    if (!group.options.some(item => item.id === id)) group.options.push({ id, modelId: candidate.model, provider: candidate.provider })
    groups.set(sourceId, group)
  }
  if (!groups.size) return null
  return { groups: [...groups.values()], current: { id: '', kind: 'subscription', provider: run.harness === 'codex' ? 'codex' : 'claude',
    modelId: typeof run.model === 'string' ? run.model : '', chosen: false, available: true } }
}
