import 'server-only'

import { Chat } from 'chat'
import { createPostgresState } from '@chat-adapter/state-pg'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { pool } from '@/lib/db'
import { handleTelegramDirectMessage, handleTelegramSlashCommand } from './handler'
import { createTelegramLogger } from './logger'

let bot: Chat | undefined

function configuration() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
  const userName = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '')
  if (!botToken || !secretToken || !userName || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(userName)) return null
  return { botToken, secretToken, userName }
}

export function isTelegramConfigured() {
  return configuration() !== null
}

export function getTelegramBot() {
  const config = configuration()
  if (!config) throw new Error('Telegram bot environment is not configured')
  if (!bot) {
    const telegram = createTelegramAdapter({ ...config, mode: 'webhook' })
    bot = new Chat({
      userName: config.userName,
      adapters: { telegram },
      state: createPostgresState({ client: pool, autoCreateSchema: false, keyPrefix: 'mikka' }),
      concurrency: 'queue',
      logger: createTelegramLogger(),
    })
    bot.onDirectMessage(handleTelegramDirectMessage)
    bot.onSlashCommand(handleTelegramSlashCommand)
  }
  return bot
}
