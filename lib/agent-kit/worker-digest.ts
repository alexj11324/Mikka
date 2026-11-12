import { digest } from './definition'

/** The exact standing policy/credential identity shared by producers and mailbox admission.
 * Prompt/retry metadata and parent references have their own separate checks. */
export function workerDefinitionDigest(value: {
  harness: string; instructions: string; model?: unknown; modelDispatch?: unknown; agentProfile?: unknown; profileOriginRunId?: unknown; pinnedDeviceId?: unknown; allowLocalRecovery?: unknown;
  subscription?: unknown; apiKey?: unknown; mailbox?: unknown; customMcp?: unknown; readOnly?: unknown; policyCeiling?: unknown; projectExecution?: unknown; taskMachine?: unknown;
}) {
  return digest({ harness: value.harness, instructions: value.instructions,
    ...(value.taskMachine ? {taskMachine:value.taskMachine} : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.modelDispatch ? { modelDispatch: value.modelDispatch } : {}),
    ...(value.agentProfile ? { agentProfile: value.agentProfile } : {}),
    ...(value.profileOriginRunId ? { profileOriginRunId: value.profileOriginRunId } : {}),
    ...(value.pinnedDeviceId ? { pinnedDeviceId: value.pinnedDeviceId } : {}),
    ...(value.allowLocalRecovery === true ? { allowLocalRecovery: true } : {}),
    ...(value.subscription ? { subscription: value.subscription } : {}),
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
    ...(value.mailbox ? { mailbox: value.mailbox } : {}),
    ...(value.customMcp ? { customMcp: value.customMcp } : {}),
    ...(value.readOnly ? { readOnly: true } : {}),
    ...(value.policyCeiling ? { policyCeiling: value.policyCeiling } : {}),
    ...(value.projectExecution ? { projectExecution: value.projectExecution } : {}),
  })
}
