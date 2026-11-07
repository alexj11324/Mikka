// What the bot avatar slot receives (docs/ui-overlay.md). The default
// (components/slots/bot-avatar.tsx) and the hosted layer's slots/bot-avatar.tsx
// both implement `BotAvatar` against these props; callers import from
// @/components/nav/bot-avatar only.

/**
 * What the bot is doing, as bloub states (Figma 196:3571): 空闲 idle (it plays
 * its own animations), 工作中 thinking (its own body, blinking), 完成 wink, 出错
 * exclaim, 离线 sleep.
 * The rest are one-off moves (wide eyes, the hexagon pose and the burst effect)
 * for moments like the first-run guide; they play at bloub's own length and the
 * caller sets the mood back to idle afterwards.
 * Nothing is drawn on or around an avatar (Alex, 2026-11-01): bloub's notify
 * badge, and the coloured ribbons and trails of its orbit, play and comet moves,
 * are never used.
 */
export type BotMood = 'idle' | 'thinking' | 'wink' | 'exclaim' | 'sleep' | BotMove

export type BotMove = 'wide' | 'hexagon' | 'burst'

/** How long each mood lasts at bloub's own pace, in seconds. */
export const BOT_MOOD_SECONDS: Record<BotMood, number> = { idle: 2.4, thinking: 2.6, wink: 1.6, exclaim: 2, sleep: 2.4, wide: 1.8, hexagon: 1.6, burst: 2.6 }

/** Visible avatar sizes, in CSS pixels. */
export const BOT_AVATAR_SIZES = { row: 16, pill: 22, message: 24, search: 28, list: 34, cell: 40, profile: 72, hero: 144 } as const

export type BotAvatarSize = keyof typeof BOT_AVATAR_SIZES

export type BotAvatarProps = {
  color?: string | null
  shape?: string | null
  /** The bot's id, when the caller has one, so a layer can give each bot one steady look. */
  id?: string | null
  /** Set by `COORDINATOR_AVATAR`, so a layer can give the Coordinator its own look. */
  coordinator?: boolean
  size?: BotAvatarSize
  mood?: BotMood
  label?: string
  still?: boolean
  brisk?: boolean
}
