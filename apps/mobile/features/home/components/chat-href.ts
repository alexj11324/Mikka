import type { Href } from 'expo-router'
import { botPath } from '@/lib/pins'
import type { HomeChat } from '../model/use-home-chats'

/** Where a home chat opens: a bot's chat, or the group chat. */
export const chatHref = (chat: HomeChat): Href => chat.row.kind === 'bot' ? botPath(chat.row.bot) : `/groups/${chat.row.group.id}`
