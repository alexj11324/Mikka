// What the iOS app's bot avatar slot receives (docs/ui-overlay.md, 「iOS app」).
// The default (slots/bot-avatar.tsx) and the hosted layer's mobile/slots/bot-avatar.tsx
// both export `BotAvatar` with these props; callers import it from @/components/icons.
//
// Every caller shows the bot's name, or labels the control the avatar sits in,
// so an avatar is decorative: hidden from VoiceOver, with no label of its own.
// Lists draw many at once (the home list, the pinned grid), so a layer's motion
// runs on the UI thread (Reanimated shared values, no React state per frame),
// stays still while the person has Reduce Motion on (`useReducedMotionPreference`
// from @/lib/reduced-motion), and the component is memoised on its props.

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
