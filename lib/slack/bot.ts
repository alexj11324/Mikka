import 'server-only'
import { Chat } from 'chat'
import { createSlackAdapter } from '@chat-adapter/slack'
import { createPostgresState } from '@chat-adapter/state-pg'
import { start } from 'workflow/api'
import { pool } from '@/lib/db'
import { slackTurn } from '@/workflows/slack/workflow'
import { slackConfig, slackOwner } from './config'

let bot: ReturnType<typeof createBot> | undefined

function createBot() {
  const config = slackConfig(process.env)
  if (!config) throw new Error('Slack bot configuration is incomplete')
  const chat = new Chat({
    userName: 'mikka',
    logger: 'silent',
    concurrency: 'concurrent',
    adapters: {
      slack: createSlackAdapter({
        botToken: config.SLACK_BOT_TOKEN,
        botUserId: config.SLACK_BOT_USER_ID,
        signingSecret: config.SLACK_SIGNING_SECRET,
      }),
    },
    state: createPostgresState({ client: pool, autoCreateSchema: false, keyPrefix: 'mikka-slack' }),
  })
  // Every request is an explicit @mention. Do not subscribe to channel messages
  // or forward the person's private Coordinator conversation into Slack.
  chat.onNewMention(async (thread, message) => {
    const raw = message.raw as { team_id?: string; team?: string }
    const userId = slackOwner(config, {
      type: 'event_callback', api_app_id: config.SLACK_APP_ID,
      team_id: raw.team_id ?? raw.team,
      event: { type: 'app_mention', user: message.author.userId, text: message.text },
    })
    if (!userId || message.author.isBot === true || message.author.isMe) return
    await start(slackTurn, [userId, thread.id, message.text.slice(0, 10_000)])
  })
  return chat
}

export function getSlackBot() {
  return bot ??= createBot()
}
