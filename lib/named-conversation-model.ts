import { mentionsIn } from './group-mentions'

/** The group turn uses the explicitly addressed responders, or routes among
 * all non-human members. A Bot's own model menu needs a single owned target. */
export function namedConversationModelBot(
  workspaceId: string | null | undefined,
  members: Parameters<typeof mentionsIn>[1],
  ownedBots: readonly { id: string }[] | undefined,
  draft = '',
): string | undefined {
  if (!workspaceId || !ownedBots?.length) return
  const mentions = mentionsIn(draft, members)
  const responders = mentions.length
    ? mentions
    : members.filter(member => member.memberType !== 'user').map(member => ({ memberType: member.memberType, memberId: member.id }))
  const target = responders[0]
  if (responders.length === 1 && target?.memberType === 'bot' && ownedBots.some(bot => bot.id === target.memberId)) return target.memberId
}
