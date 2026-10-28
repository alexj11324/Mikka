import { z } from 'zod'
import type { Harness } from '@mikka/protocol/harness'
import { digest, type DefinitionSnapshot } from './definition'
import { snapshotMailboxTools, workerMailboxScope, type WorkerMailboxScope, type WorkerMailboxGrant } from '../personal-mailbox-capability'

export interface WorkerDefinitionSnapshot {
  schemaVersion: 1
  kind: 'worker'
  harness: Harness
  instructions: string
  definitionDigest: string
  promptDigest: string
  /** Pinned subscription provenance, or CLI default selection; neither is a model execution receipt. */
  modelSource: 'native-default' | 'subscription'
  subscription?: { bindingId: string; modelId: string; route: string }
  parent: { executionId: string; revisionId: string; revision: number; definitionDigest: string } | null
  /** Explicit parent-selected tools, frozen only for newly authorized runs. */
  mailbox?: WorkerMailboxGrant
}

/** Captured atomically with dispatch, not retroactively inferred from a renamed Agent. */
export function freezeWorkerDefinition(input: { harness: Harness; instructions: string; prompt: string; parent: DefinitionSnapshot | null; executionId: string | null; subscription?: { id: string; modelId: string; route: string } | null; mailboxEnabled?: boolean; mailboxScope?: WorkerMailboxScope }): WorkerDefinitionSnapshot {
  if (Boolean(input.parent) !== Boolean(input.executionId)) throw new Error('agentWorkerParentIncomplete')
  const subscription = input.subscription ? { bindingId:z.uuid().parse(input.subscription.id),modelId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(input.subscription.modelId),route:input.subscription.route } : undefined
  if (subscription && subscription.route !== (input.harness === 'codex' ? 'codex_cli' : input.harness === 'claude_code' ? 'claude_code_cli' : null)) throw new Error('agentWorkerSubscriptionMismatch')
  const tools = input.mailboxEnabled ? snapshotMailboxTools(input.parent) : []
  const mailbox = tools.length && input.mailboxScope && ['claude_code', 'codex'].includes(input.harness)
    ? { version: 2 as const, tools, scope: workerMailboxScope.parse(input.mailboxScope) } : undefined
  return {
    schemaVersion: 1, kind: 'worker', harness: input.harness, instructions: input.instructions,
    definitionDigest: digest({ harness: input.harness, instructions: input.instructions, ...(subscription ? { subscription } : {}), ...(mailbox ? { mailbox } : {}) }),
    promptDigest: digest(input.prompt), modelSource: subscription ? 'subscription' : 'native-default', ...(subscription ? { subscription } : {}),
    parent: input.parent && input.executionId ? { executionId: input.executionId,revisionId: input.parent.revisionId,revision: input.parent.revision,definitionDigest: input.parent.definitionDigest } : null,
    ...(mailbox ? { mailbox } : {}),
  }
}

/** A transport retry changes its task brief, never its standing definition or parent identity. */
export function retryWorkerDefinition(snapshot: WorkerDefinitionSnapshot | null | undefined, prompt: string): WorkerDefinitionSnapshot | null {
  return snapshot ? { ...structuredClone(snapshot),promptDigest:digest(prompt) } : null
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
