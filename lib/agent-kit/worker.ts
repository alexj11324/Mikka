import type { ProjectExecutionSnapshot } from '../project-resources/contracts'
import type { ExecutionIdentity } from '../execution-identity'
import type { RunTraceContext } from '@mikka/protocol/trace-context'
import type { AgentProfileSelection } from '../factory/agent-profile'
import { workerDefinitionDigest } from './worker-digest'
import { z } from 'zod'
import type { Harness } from '@mikka/protocol/harness'
import { digest, type DefinitionSnapshot } from './definition'
import { snapshotMailboxTools, workerMailboxScope, type WorkerMailboxScope, type WorkerMailboxGrant } from '../personal-mailbox-capability'
import type { RepositoryAdmission } from '../repository-admission'
import { mcpAuthoritySchema, type McpAuthority } from '../plugins/contracts'
import type { OrderEntry, RunLocation } from '../model-order-plan'
import { runPolicySchema, type RunPolicy } from '@mikka/protocol/agent-policy'
import { modelTier, supportedModelEfforts, type FrozenModelRoutingSnapshot } from '../model-routing'

/** Host-recorded model choice, distinct from the CLI's explicit model argument. */
export interface WorkerModelDispatch {
  mode: 'preference' | 'picked'
  location?: RunLocation
  entry?: OrderEntry
  /** Host-validated difficulty choice, frozen with the actual model. */
  routing?: FrozenModelRoutingSnapshot
}

export interface WorkerDefinitionSnapshot {
  /** Correlation only; excluded from the frozen execution/authority digest. */
  traceContext?: RunTraceContext
  /** Trusted dispatch identity; absent on historical runs, never inferred retroactively. */
  executionIdentity?: ExecutionIdentity
  /** Project/Repository/Environment configuration frozen at admission; never backfilled on old runs. */
  projectExecution?: ProjectExecutionSnapshot
  /** Copied only from the host's authorized parent execution; legacy workers gain nothing. */
  customMcp?: McpAuthority
  schemaVersion: 1
  kind: 'worker'
  harness: Harness
  instructions: string
  definitionDigest: string
  promptDigest: string
  /** Pinned subscription or API key provenance, or CLI default selection; none is a model execution receipt. */
  modelSource: 'native-default' | 'subscription' | 'api_key'
  cliModelSelection?: 'auto' | 'explicit'
  model?: string
  /** Absent on historical runs: a model argument alone never grants automatic switching. */
  modelDispatch?: WorkerModelDispatch
  /** Authorized role and definition frozen at admission, independent of its physical runner. */
  agentProfile?: AgentProfileSelection
  /** Verified prior started run whose native session keeps this role after a profile edit. */
  profileOriginRunId?: string
  /** Host-frozen source policy: a model continuation never gains the next worker's broader permissions. */
  policyCeiling?: RunPolicy
  pinnedDeviceId?: string
  /** Host-selected automatic Cloud placement may recover on an authorized local device. Absent means no grant. */
  allowLocalRecovery?: true
  subscription?: { bindingId: string; modelId: string; route: string }
  /** The person's API key the run uses, by id only; the key is opened at claim (`apiKeyForRun`). Never with `subscription`. */
  apiKey?: { keyId: string; model: string }
  parent: { executionId: string; revisionId: string; revision: number; definitionDigest: string } | null
  /** Explicit parent-selected tools, frozen only for newly authorized runs. */
  mailbox?: WorkerMailboxGrant
  /** Server-owned authority accepted with this local task, preserved by retries. */
  repositoryAdmission?: RepositoryAdmission
  /** A run that changes nothing (investigation, review): read-only worktree and no task branch. */
  readOnly?: true
}

/** Captured atomically with dispatch, not retroactively inferred from a renamed Agent. */
export function freezeWorkerDefinition(input: { harness: Harness; instructions: string; prompt: string; parent: DefinitionSnapshot | null; executionId: string | null; model?: string; modelDispatch?: WorkerModelDispatch; agentProfile?: AgentProfileSelection; policyCeiling?: RunPolicy; pinnedDeviceId?: string; allowLocalRecovery?: true; subscription?: { id: string; modelId: string; route: string } | null; apiKey?: { keyId: string; model: string } | null; mailboxEnabled?: boolean; mailboxScope?: WorkerMailboxScope; readOnly?: boolean }): WorkerDefinitionSnapshot {
  if (Boolean(input.parent) !== Boolean(input.executionId)) throw new Error('agentWorkerParentIncomplete')
  if (input.subscription && input.apiKey) throw new Error('agentWorkerCredentialConflict')
  if (input.apiKey && input.harness !== 'codex' && input.harness !== 'claude_code') throw new Error('agentWorkerApiKeyMismatch')
  const apiKey = input.apiKey ? { keyId: z.uuid().parse(input.apiKey.keyId), model: z.string().trim().min(1).max(128).parse(input.apiKey.model) } : undefined
  const subscription = input.subscription ? { bindingId:z.uuid().parse(input.subscription.id),modelId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(input.subscription.modelId),route:input.subscription.route } : undefined
  if (subscription && subscription.route !== (input.harness === 'codex' ? 'codex_cli' : input.harness === 'claude_code' ? 'claude_code_cli' : null)) throw new Error('agentWorkerSubscriptionMismatch')
  if (subscription && input.model && input.model !== subscription.modelId) throw new Error('agentWorkerSubscriptionMismatch')
  // Explicit dispatches already carry the provider model from their exact
  // binding. A subscription alone preserves the existing CLI auto selection.
  const model = apiKey?.model ?? input.model
  const modelDispatch = apiKey ? apiKeyModelDispatch(input.modelDispatch, apiKey) : input.modelDispatch ? structuredClone(input.modelDispatch) : undefined
  const agentProfile = input.agentProfile ? structuredClone(input.agentProfile) : undefined
  const policyCeiling = input.policyCeiling ? runPolicySchema.parse(input.policyCeiling) : undefined
  const customMcp = input.parent?.personalPlugins?.mcpAuthority?.servers.length
    ? mcpAuthoritySchema.parse(structuredClone(input.parent.personalPlugins.mcpAuthority)) : undefined
  const tools = input.mailboxEnabled ? snapshotMailboxTools(input.parent) : []
  const mailbox = tools.length && input.mailboxScope && ['claude_code', 'codex'].includes(input.harness)
    ? { version: 2 as const, tools, scope: workerMailboxScope.parse(input.mailboxScope) } : undefined
  return {
    ...(model ? {model:z.string().trim().min(1).max(128).parse(model)} : {}),
    ...(modelDispatch ? { modelDispatch } : {}),
    ...(agentProfile ? { agentProfile } : {}),
    ...(policyCeiling ? { policyCeiling } : {}),
    ...(input.pinnedDeviceId ? {pinnedDeviceId:z.uuid().parse(input.pinnedDeviceId)} : {}),
    ...(input.allowLocalRecovery === true ? { allowLocalRecovery: true as const } : {}),
    cliModelSelection: model ? 'explicit' : 'auto',
    schemaVersion: 1, kind: 'worker', harness: input.harness, instructions: input.instructions,
    definitionDigest: workerDefinitionDigest({ harness: input.harness, instructions: input.instructions, model, modelDispatch, agentProfile, policyCeiling, pinnedDeviceId: input.pinnedDeviceId, allowLocalRecovery: input.allowLocalRecovery, subscription, apiKey, mailbox, customMcp, readOnly: input.readOnly }),
    promptDigest: digest(input.prompt), modelSource: subscription ? 'subscription' : apiKey ? 'api_key' : 'native-default', ...(subscription ? { subscription } : {}), ...(apiKey ? { apiKey } : {}),
    parent: input.parent && input.executionId ? { executionId: input.executionId,revisionId: input.parent.revisionId,revision: input.parent.revision,definitionDigest: input.parent.definitionDigest } : null,
    ...(mailbox ? { mailbox } : {}),
    ...(customMcp ? { customMcp } : {}),
    ...(input.readOnly ? { readOnly: true as const } : {}),
  }
}

/** A transport retry changes its task brief, never its standing definition or parent identity. */
export function retryWorkerDefinition(snapshot: WorkerDefinitionSnapshot | null | undefined, prompt: string): WorkerDefinitionSnapshot | null {
  return snapshot ? { ...structuredClone(snapshot),promptDigest:digest(prompt) } : null
}

/**
 * A quota continuation's definition: the same Agent and parent, frozen on the
 * person's API key instead of the subscription whose quota ran out.
 */
export function apiKeyWorkerDefinition(snapshot: WorkerDefinitionSnapshot, prompt: string, apiKey: { keyId: string; model: string }): WorkerDefinitionSnapshot {
  const { subscription: _subscription, apiKey: _apiKey, ...rest } = structuredClone(snapshot)
  const key = { keyId: z.uuid().parse(apiKey.keyId), model: z.string().trim().min(1).max(128).parse(apiKey.model) }
  const modelDispatch = apiKeyModelDispatch(rest.modelDispatch, key)
  return {
    ...rest, model: key.model, cliModelSelection: 'explicit', modelSource: 'api_key', apiKey: key, promptDigest: digest(prompt),
    ...(modelDispatch ? { modelDispatch } : {}),
    definitionDigest: workerDefinitionDigest({ ...rest, model: key.model, modelDispatch, subscription: undefined, apiKey: key }),
  }
}

/** A quota switch retains the person's choice policy, but names the key actually used. */
function apiKeyModelDispatch(dispatch: WorkerModelDispatch | undefined, key: { keyId: string; model: string }): WorkerModelDispatch | undefined {
  if (!dispatch) return undefined
  const frozen = structuredClone(dispatch)
  const entry = frozen.entry
  if (entry && (entry.source.kind !== 'api_key' || entry.source.keyId !== key.keyId || entry.model !== key.model)) {
    frozen.entry = { ...entry, id: `api_key:${entry.harness}:${key.model}:${key.keyId}`, model: key.model, source: { kind: 'api_key', keyId: key.keyId } }
    if (frozen.routing && frozen.routing.model !== key.model) {
      const { effort, ...previous } = frozen.routing
      frozen.routing = { ...previous, model: key.model, harness: entry.harness, tier: modelTier(key.model), reason: 'list_order', previousModel: previous.model,
        ...(effort && supportedModelEfforts(key.model, entry.harness).includes(effort) ? { effort } : {}) }
    }
  }
  return frozen
}

/** Match a claimed run's subscription without following a later Agent edit. */
export function workerSubscriptionMatches(snapshot: WorkerDefinitionSnapshot | null | undefined, currentHarness: string, binding: { id:string; modelId:string; route:string }): boolean {
  const harness=snapshot?.harness ?? currentHarness
  const route=harness==='codex'?'codex_cli':harness==='claude_code'?'claude_code_cli':null
  if (!route || binding.route!==route) return false
  if (!snapshot) return true
  const pinned=snapshot.subscription
  return Boolean(pinned && pinned.bindingId===binding.id && pinned.modelId===binding.modelId && pinned.route===binding.route)
}
