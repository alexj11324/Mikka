import { cloudStartupDiagnosticCandidate } from './startup-diagnostics'
import { createHash } from 'node:crypto'
import { anonymousCodexHintSchema } from '@mikka/protocol/codex-startup'
import { applyApprovalMode, resolveAgentSettings } from '@mikka/protocol/agent-policy'
import type { WorkerDefinitionSnapshot } from '../agent-kit/worker'
import { RUN_DECISION_CATALOGUE } from '../project-map/mcp-tool'


/** Speculative non-secret configuration from the already-loaded frozen row.
 * No fresh permission, credential or assignment is granted here. A mismatch
 * at normal claim discards this process before the existing cold path. */
export function anonymousCodexStartupHint(input: {
  runId: string; bootstrap: string | { sha256: string }; kind: string; repository: string | null; userId: string; botId: string | null
  freshTask: boolean
  /** Trusted operator opt-in for the isolated candidate gate; never an execution grant. */
  diagnostics?: true
  definition: WorkerDefinitionSnapshot | null | undefined
}) {
  const d = input.definition
  if (!input.freshTask || !d || d.harness !== 'codex' || d.modelSource !== 'subscription' ||
    d.cliModelSelection !== 'explicit' || !d.subscription || !d.model || d.customMcp ||
    !['implement', 'fix', 'plan'].includes(input.kind) || !input.repository?.startsWith('v2/github.com/')) return ''
  let policy = d.policyCeiling ?? resolveAgentSettings(null, null, 'cloud').policy
  policy = { ...policy, permissions: { ...policy.permissions, git_push: d.repositoryAdmission ? 'allow' : 'deny' } }
  if (d.readOnly) policy = applyApprovalMode(policy, 'read_only')
  const parsed = anonymousCodexHintSchema.safeParse({
    version: 1, profile: 'cloud_repository_codex_0166_v1', runId: input.runId,
    bootstrapSha256: typeof input.bootstrap === 'string' ? createHash('sha256').update(input.bootstrap).digest('hex') : input.bootstrap.sha256,
    model: d.model, effort: d.agentProfile?.effort ?? d.modelDispatch?.routing?.effort,
    kind: input.kind, github: true, diagnostics: input.diagnostics === true || cloudStartupDiagnosticCandidate({
      deviceKind: 'cloud', repository: input.repository.slice('v2/github.com/'.length), harness: d.harness,
      subscriptionBindingId: d.subscription.bindingId, run: { userId: input.userId, botId: input.botId, agentDefinition: d },
    }), policy,
    decisionCatalogue: RUN_DECISION_CATALOGUE, mailboxTools: d.mailbox?.tools ?? [],
  })
  if (!parsed.success) return ''
  const encoded = JSON.stringify(parsed.data)
  return Buffer.byteLength(encoded) <= 32768 ? encoded : ''
}
