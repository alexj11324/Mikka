import 'server-only'

import { getTelegramClient } from './client'
import { handleTelegramDirectMessage, handleTelegramSlashCommand } from './handler'

export { isTelegramConfigured } from './client'

let handlersRegistered = false

export function getTelegramBot() {
  const bot = getTelegramClient()
  if (!handlersRegistered) {
    bot.onDirectMessage(handleTelegramDirectMessage)
    bot.onSlashCommand(handleTelegramSlashCommand)
    handlersRegistered = true
  }
  return bot
}
