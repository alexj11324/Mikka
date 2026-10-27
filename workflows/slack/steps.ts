export async function postSlackReply(threadId: string, text: string) {
  'use step'
  const { getSlackBot } = await import('@/lib/slack/bot')
  const bot = getSlackBot()
  await bot.initialize()
  await bot.thread(threadId).post({ markdown: text })
}
