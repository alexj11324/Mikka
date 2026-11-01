// Shared by the web group chat and the phone's (apps/mobile/lib/group.ts), so a message names the same bots on both.

/** The group's bots a message names as `@name`, as the server's mentions (a mentioned bot answers it). */
export function mentionsIn(body: string, members: readonly { id: string; name: string; memberType: 'user' | 'agent' | 'bot' }[]) {
  const text = body.toLowerCase()
  return members
    .filter(member => member.memberType !== 'user' && member.name && text.includes(`@${member.name.toLowerCase()}`))
    .map(member => ({ memberType: member.memberType, memberId: member.id }))
}
