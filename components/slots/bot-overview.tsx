import type { BotOverviewProps } from './bot-overview-contract'

/** Official Web and Desktop resolve this component from the required provider. */
export function BotOverview(_props: BotOverviewProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: bot-overview')
}
