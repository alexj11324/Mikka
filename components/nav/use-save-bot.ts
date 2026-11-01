'use client'

import { useSWRConfig } from 'swr'
import { updateBot, type BotView } from '@/app/actions/bots'

export type BotPatch = Partial<Pick<BotView, 'name' | 'color' | 'shape'>>

/**
 * Saves a bot's name or look. The change shows at once wherever `bots` is read
 * (bot list, chat title, right panel) and rolls back if it does not save; the
 * returned promise then rejects with an `Errors` code as its message.
 */
export function useSaveBot() {
  const { mutate } = useSWRConfig()
  return async (botId: string, patch: BotPatch) => {
    await mutate<BotView[]>('bots', async current => {
      let result: Awaited<ReturnType<typeof updateBot>>
      try {
        result = await updateBot({ botId, ...patch })
      } catch {
        throw new Error('generic')
      }
      if (result.error) throw new Error(result.error)
      const saved = { id: result.id, name: result.name, color: result.color, shape: result.shape }
      return (current ?? []).map(bot => bot.id === botId ? saved : bot)
    }, {
      optimisticData: current => (current ?? []).map(bot => bot.id === botId ? { ...bot, ...patch } : bot),
      rollbackOnError: true,
      revalidate: false,
    })
  }
}
