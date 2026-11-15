/** Group turns freeze each responding Bot's own model. A single owned Bot
 * gives the composer an unambiguous target after both conversation reads. */
export function namedConversationModelBot(
  workspaceId: string | null | undefined,
  members: readonly { id: string; memberType: 'user' | 'agent' | 'bot' }[],
  ownedBots: readonly { id: string }[] | undefined,
): string | undefined {
  if (!workspaceId || !ownedBots?.length) return
  const responders = members.filter(member => member.memberType !== 'user')
  const bot = responders[0]
  if (responders.length === 1 && bot?.memberType === 'bot' && ownedBots.some(owned => owned.id === bot.id)) return bot.id
}
