// What the first-run guide receives (docs/ui-overlay.md). The open-source UI
// draws today's guide, a conversation with the person's first Bot; a UI layer may
// draw its own over the same APIs (createBot, Settings › 模型订阅's rows, the
// workspace's E2B key through `saveKey`, connected apps, completeOnboarding), as
// long as nothing the guide does goes missing and `onDone` gets the Bot it made.
import type { BotView } from '@/app/actions/bots'
import type { E2BKeyResult, OnboardingComputer } from '@/components/onboarding/onboarding'

export type OnboardingProps = {
  /** `ask`: the person can add the workspace's E2B key here; `none`: the cloud computer needs nothing from them. */
  computer?: OnboardingComputer
  saveKey?: (apiKey: string) => Promise<E2BKeyResult>
  workspaceId?: string
  /** After completeOnboarding: the Bot the guide made or found, whose chat opens next (it greets the person there). */
  onDone: (bot: BotView | null) => void
}
