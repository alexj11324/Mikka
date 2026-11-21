import type { BotModelMenu } from './bot-model-menu-view'

/**
 * The picker can paint a requested model immediately while the server saves it.
 * "checking" is deliberate: an optimistic label is NOT an authorization or
 * proof that this credential is currently available. The server's returned
 * menu remains the authoritative choice and rolls the preview back on failure.
 */
export function previewBotModelChoice(menu: BotModelMenu, id: string): BotModelMenu | null {
  for (const group of menu.groups) {
    const option = group.options.find(value => value.id === id)
    if (!option) continue
    return {
      ...menu,
      current: {
        ...option,
        kind: group.kind,
        chosen: true,
        available: false,
        availability: 'checking',
        ...(group.credentialLabel ? { credentialLabel: group.credentialLabel } : {}),
      },
    }
  }
  return null
}
