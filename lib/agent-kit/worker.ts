import { z } from 'zod'
import type { Harness } from '@mikka/protocol/harness'
import { digest, type DefinitionSnapshot } from './definition'

export interface WorkerDefinitionSnapshot {
  schemaVersion: 1
  kind: 'worker'
  harness: Harness
  instructions: string
  definitionDigest: string
  promptDigest: string
  /** The CLI chooses its current default; this is not a claimed model execution receipt. */
  modelSource: 'native-default' | 'subscription'
  subscription?: { bindingId: string; modelId: string; route: string }
  parent: { executionId: string; revisionId: string; revision: number; definitionDigest: string } | null
}

/** Captured atomically with dispatch, not retroactively inferred from a renamed Agent. */
export function freezeWorkerDefinition(input: { harness: Harness; instructions: string; prompt: string; parent: DefinitionSnapshot | null; executionId: string | null; subscription?: { id: string; modelId: string; route: string } | null }): WorkerDefinitionSnapshot {
  if (Boolean(input.parent) !== Boolean(input.executionId)) throw new Error('agentWorkerParentIncomplete')
  const subscription = input.subscription ? { bindingId:z.uuid().parse(input.subscription.id),modelId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(input.subscription.modelId),route:input.subscription.route } : undefined
  if (subscription && subscription.route !== (input.harness === 'codex' ? 'codex_cli' : input.harness === 'claude_code' ? 'claude_code_cli' : null)) throw new Error('agentWorkerSubscriptionMismatch')
  return {
    schemaVersion: 1, kind: 'worker', harness: input.harness, instructions: input.instructions,
    definitionDigest: digest({ harness: input.harness, instructions: input.instructions, ...(subscription ? { subscription } : {}) }),
    promptDigest: digest(input.prompt), modelSource: subscription ? 'subscription' : 'native-default', ...(subscription ? { subscription } : {}),
    parent: input.parent && input.executionId ? { executionId: input.executionId,revisionId: input.parent.revisionId,revision: input.parent.revision,definitionDigest: input.parent.definitionDigest } : null,
  }
}

/** A transport retry changes its task brief, never its standing definition or parent identity. */
export function retryWorkerDefinition(snapshot: WorkerDefinitionSnapshot | null | undefined, prompt: string): WorkerDefinitionSnapshot | null {
  return snapshot ? { ...structuredClone(snapshot),promptDigest:digest(prompt) } : null
}
