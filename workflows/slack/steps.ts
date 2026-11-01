export async function postSlackReply(threadId: string, text: string) {
  'use step'
  const { getSlackBot } = await import('@/lib/slack/bot')
  const bot = getSlackBot()
  await bot.initialize()
  await bot.thread(threadId).post({ markdown: text })
}

/** Slack talks to the person's Coordinator, the bot row lib/coordinator/coordinator-bot.ts names. */
export async function slackCoordinatorBot(userId: string) {
  'use step'
  return (await import('@/lib/coordinator/coordinator-bot')).chatBotId(userId, null)
}
