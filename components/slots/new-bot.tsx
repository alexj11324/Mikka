import type { NewBotProps } from './new-bot-contract'

/** Type contract for public tooling. Official clients link the provider at build time. */
export function NewBot(_props: NewBotProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: new-bot')
}
