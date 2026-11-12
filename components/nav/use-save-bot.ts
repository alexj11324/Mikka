'use client'

import { useSWRConfig } from 'swr'
import { updateBot, type BotView } from '@/app/actions/bots'
import { isBotListKey } from '@/lib/live/list-read'
import { botKeys } from '@/lib/swr/keys'

export type BotPatch = Partial<Pick<BotView, 'name' | 'color' | 'shape'>>

/**
 * Saves a bot's name or look. The change shows at once wherever `bots` is read
 * (bot list, chat title, right panel) and rolls back if it does not save; the
 * returned promise then rejects with an `Errors` code as its message.
 */
export function useSaveBot() {
  const { mutate } = useSWRConfig()
  return async (botId: string, patch: BotPatch) => {
    await mutate<BotView[]>(botKeys.all(), async current => {
      let result: Awaited<ReturnType<typeof updateBot>>
      try {
        result = await updateBot({ botId, ...patch })
      } catch (cause) {
        throw new Error('generic', { cause })
      }
      if (result.error) throw new Error(result.error)
      const saved = { id: result.id, name: result.name, color: result.color, shape: result.shape }
      return (current ?? []).map(bot => bot.id === botId ? saved : bot)
    }, {
      optimisticData: current => (current ?? []).map(bot => bot.id === botId ? { ...bot, ...patch } : bot),
      rollbackOnError: true,
      revalidate: false,
    })
    // The shell and settings own scoped reads with different result shapes.
    // Refresh them through their authorized fetchers after the single write.
    await mutate(key => key !== botKeys.all() && isBotListKey(key))
  }
}
