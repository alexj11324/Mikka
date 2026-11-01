import { workerDefinitionDigest } from './worker-digest'
import { z } from 'zod'
import type { Harness } from '@mikka/protocol/harness'
import { digest, type DefinitionSnapshot } from './definition'
import { snapshotMailboxTools, workerMailboxScope, type WorkerMailboxScope, type WorkerMailboxGrant } from '../personal-mailbox-capability'
import type { RepositoryAdmission } from '../repository-admission'

export interface WorkerDefinitionSnapshot {
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
  pinnedDeviceId?: string
  subscription?: { bindingId: string; modelId: string; route: string }
  /** The person's API key the run uses, by id only; the key is opened at claim (`apiKeyForRun`). Never with `subscription`. */
  apiKey?: { keyId: string; model: string }
  parent: { executionId: string; revisionId: string; revision: number; definitionDigest: string } | null
  /** Explicit parent-selected tools, frozen only for newly authorized runs. */
  mailbox?: WorkerMailboxGrant
  /** Server-owned authority accepted with this local task, preserved by retries. */
  repositoryAdmission?: RepositoryAdmission
  /** A run that changes nothing (investigation, review): read-only policy, no commit, push or PR, so no push approval. */
  readOnly?: true
}

/** Captured atomically with dispatch, not retroactively inferred from a renamed Agent. */
export function freezeWorkerDefinition(input: { harness: Harness; instructions: string; prompt: string; parent: DefinitionSnapshot | null; executionId: string | null; model?: string; pinnedDeviceId?: string; subscription?: { id: string; modelId: string; route: string } | null; apiKey?: { keyId: string; model: string } | null; mailboxEnabled?: boolean; mailboxScope?: WorkerMailboxScope; readOnly?: boolean }): WorkerDefinitionSnapshot {
  if (Boolean(input.parent) !== Boolean(input.executionId)) throw new Error('agentWorkerParentIncomplete')
  if (input.subscription && input.apiKey) throw new Error('agentWorkerCredentialConflict')
  if (input.apiKey && input.harness !== 'codex' && input.harness !== 'claude_code') throw new Error('agentWorkerApiKeyMismatch')
  const apiKey = input.apiKey ? { keyId: z.uuid().parse(input.apiKey.keyId), model: z.string().trim().min(1).max(128).parse(input.apiKey.model) } : undefined
  // An API-key run asks its key's model of the Agent.
  const model = apiKey?.model ?? input.model
  const subscription = input.subscription ? { bindingId:z.uuid().parse(input.subscription.id),modelId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(input.subscription.modelId),route:input.subscription.route } : undefined
  if (subscription && subscription.route !== (input.harness === 'codex' ? 'codex_cli' : input.harness === 'claude_code' ? 'claude_code_cli' : null)) throw new Error('agentWorkerSubscriptionMismatch')
  const tools = input.mailboxEnabled ? snapshotMailboxTools(input.parent) : []
  const mailbox = tools.length && input.mailboxScope && ['claude_code', 'codex'].includes(input.harness)
    ? { version: 2 as const, tools, scope: workerMailboxScope.parse(input.mailboxScope) } : undefined
  return {
    ...(model ? {model:z.string().trim().min(1).max(128).parse(model)} : {}),
    ...(input.pinnedDeviceId ? {pinnedDeviceId:z.uuid().parse(input.pinnedDeviceId)} : {}),
    cliModelSelection: model ? 'explicit' : 'auto',
    schemaVersion: 1, kind: 'worker', harness: input.harness, instructions: input.instructions,
    definitionDigest: workerDefinitionDigest({ harness: input.harness, instructions: input.instructions, model, pinnedDeviceId: input.pinnedDeviceId, subscription, apiKey, mailbox, readOnly: input.readOnly }),
    promptDigest: digest(input.prompt), modelSource: subscription ? 'subscription' : apiKey ? 'api_key' : 'native-default', ...(subscription ? { subscription } : {}), ...(apiKey ? { apiKey } : {}),
    parent: input.parent && input.executionId ? { executionId: input.executionId,revisionId: input.parent.revisionId,revision: input.parent.revision,definitionDigest: input.parent.definitionDigest } : null,
    ...(mailbox ? { mailbox } : {}),
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
  return {
    ...rest, model: key.model, cliModelSelection: 'explicit', modelSource: 'api_key', apiKey: key, promptDigest: digest(prompt),
    definitionDigest: workerDefinitionDigest({ ...rest, model: key.model, subscription: undefined, apiKey: key }),
  }
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
