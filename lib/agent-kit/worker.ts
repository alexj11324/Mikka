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
  modelSource: 'native-default'
  parent: { executionId: string; revisionId: string; revision: number; definitionDigest: string } | null
}

/** Captured atomically with dispatch, not retroactively inferred from a renamed Agent. */
export function freezeWorkerDefinition(input: { harness: Harness; instructions: string; prompt: string; parent: DefinitionSnapshot | null; executionId: string | null }): WorkerDefinitionSnapshot {
  if (Boolean(input.parent) !== Boolean(input.executionId)) throw new Error('agentWorkerParentIncomplete')
  return {
    schemaVersion: 1, kind: 'worker', harness: input.harness, instructions: input.instructions,
    definitionDigest: digest({ harness: input.harness, instructions: input.instructions }),
    promptDigest: digest(input.prompt), modelSource: 'native-default',
    parent: input.parent && input.executionId ? { executionId: input.executionId,revisionId: input.parent.revisionId,revision: input.parent.revision,definitionDigest: input.parent.definitionDigest } : null,
  }
}

/** A transport retry changes its task brief, never its standing definition or parent identity. */
export function retryWorkerDefinition(snapshot: WorkerDefinitionSnapshot | null | undefined, prompt: string): WorkerDefinitionSnapshot | null {
  return snapshot ? { ...snapshot,promptDigest:digest(prompt) } : null
}
