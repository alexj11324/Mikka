'use client'

import { BotAvatar } from '@ui-slot/bot-avatar'
import type { BotAvatarSize, BotMood } from '@/components/slots/bot-avatar-contract'
import { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from '@/lib/bot-shapes'

export { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape }
export { BOT_MOOD_SECONDS, type BotAvatarProps, type BotAvatarSize, type BotMood, type BotMove } from '@/components/slots/bot-avatar-contract'

/**
 * A bot's avatar. The look is a UI slot (docs/ui-overlay.md): the bloub blob
 * in components/slots/bot-avatar.tsx, or the hosted layer's.
 */
export { BotAvatar }

/** A steady colour for something that has a name but no colour of its own, such as an agent assignee. */
export function colorFor(name: string): BotColor {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  // Cream is left out: next to other avatars it reads as empty.
  return BOT_COLORS[Math.abs(hash) % (BOT_COLORS.length - 1)]
}

/** The Coordinator's look (Figma 202:4518): the default ink circle, no badge. */
export const COORDINATOR_AVATAR = { color: 'encre', shape: 'cercle', coordinator: true } as const

/**
 * The Coordinator is a bot like any other. Where the same slot can show the
 * Coordinator or a bot, render `BotAvatar` with `COORDINATOR_AVATAR` instead,
 * so switching keeps one mounted blob that morphs.
 */
export function CoordinatorAvatar({ size = 'list', mood }: { size?: BotAvatarSize; mood?: BotMood }) {
  return <BotAvatar {...COORDINATOR_AVATAR} size={size} mood={mood} />
}
