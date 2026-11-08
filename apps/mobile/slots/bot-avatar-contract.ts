// What the iOS app's bot avatar slot receives (docs/ui-overlay.md, 「iOS app」).
// The default (slots/bot-avatar.tsx) and the hosted layer's mobile/slots/bot-avatar.tsx
// both export `BotAvatar` with these props; callers import it from @/components/icons.

export type BotAvatarProps = {
  /** A colour id from `BOT_COLORS` (@/lib/bot-look); unknown or missing is ink. */
  color?: string
  /** A shape id from the web's sixteen (`BOT_SHAPE_DRAWINGS`); unknown or missing is cercle. */
  shape?: string
  /** The bot's id, when the caller has one, so a layer can give each bot one steady look (most bots keep the default ink circle). */
  id?: string
  /** The person's Coordinator, so a layer can give it its own look. */
  coordinator?: boolean
  /** Width and height, in points. */
  size?: number
}
