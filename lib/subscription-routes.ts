import 'server-only'

/**
 * Which subscription routes run for a subscription's owner, decided per person
 * in PostHog (Alex, 2026-11-02: feature switches are PostHog flags):
 * mikka-byos-subscription-chat lets the owner's subscription answer bot chats
 * (codex_cpa only, see FLAGGED_CHAT_ROUTES); mikka-byos-subscription-native lets it run threads
 * on a computer (claude_code_cli, codex_cli). The model menu, the bot's model
 * resolver and the subscription runtime all read this one check, so a route
 * that is off is neither offered nor run. Off when PostHog is unreachable
 * (serverFlagEnabled fails closed and logs). MIKKA_BYOS_VALIDATED_MODEL_ROUTES
 * and MIKKA_BYOS_VALIDATED_NATIVE_ROUTES still turn a route on for every owner,
 * for test environments; production does not set them.
 */
export const SUBSCRIPTION_ROUTE_FLAGS = { chat: 'mikka-byos-subscription-chat', native: 'mikka-byos-subscription-native' } as const

const CHAT_ROUTES = ['claude_cpa', 'codex_cpa']
/**
 * The chat routes the per-person flag can turn on. Not claude_cpa: Anthropic answers a Claude
 * subscription's token with 429 rate_limit_error when the client is not Claude Code (production,
 * 2026-11-02), and Mikka does not pose as Claude Code. A Claude subscription is not offered in bot chats.
 */
const FLAGGED_CHAT_ROUTES = ['codex_cpa']
const NATIVE_ROUTES = ['claude_code_cli', 'codex_cli']

export async function subscriptionRouteReady(
  route: string,
  ownerId: string,
  env: Record<string, string | undefined> = process.env,
  flag: (key: string, userId: string) => Promise<boolean> = async (key, userId) => (await import('./posthog-server')).serverFlagEnabled(key, userId),
): Promise<boolean> {
  const chat = CHAT_ROUTES.includes(route)
  if (!chat && !NATIVE_ROUTES.includes(route)) return false
  const listed = (env[chat ? 'MIKKA_BYOS_VALIDATED_MODEL_ROUTES' : 'MIKKA_BYOS_VALIDATED_NATIVE_ROUTES'] ?? '').split(',')
  if (listed.includes(route)) return true
  if (chat && !FLAGGED_CHAT_ROUTES.includes(route)) return false
  return flag(chat ? SUBSCRIPTION_ROUTE_FLAGS.chat : SUBSCRIPTION_ROUTE_FLAGS.native, ownerId)
}
