import { digest } from './definition'

/** The exact standing policy/credential identity shared by producers and mailbox admission.
 * Prompt/retry metadata and parent references have their own separate checks. */
export function workerDefinitionDigest(value: {
  harness: string; instructions: string; model?: unknown; pinnedDeviceId?: unknown;
  subscription?: unknown; apiKey?: unknown; mailbox?: unknown; readOnly?: unknown;
}) {
  return digest({ harness: value.harness, instructions: value.instructions,
    ...(value.model ? { model: value.model } : {}),
    ...(value.pinnedDeviceId ? { pinnedDeviceId: value.pinnedDeviceId } : {}),
    ...(value.subscription ? { subscription: value.subscription } : {}),
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
    ...(value.mailbox ? { mailbox: value.mailbox } : {}),
    ...(value.readOnly ? { readOnly: true } : {}),
  })
}
