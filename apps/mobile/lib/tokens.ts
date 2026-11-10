/**
 * Mikka's colour tokens, as data: `lib/theme.ts` turns them into React Native colours, and
 * `styles/tokens.css` gives the same values to Uniwind, HeroUI Native and beUI
 * (`tests/theme-tokens.test.mts` keeps the two in step). Edit a value here and in tokens.css together.
 */
export type Token = {
  /** The iOS system colour, a DynamicColorIOS where the system has none, or a fixed hex. */
  ios: string | { light: string; dark: string; highContrastLight?: string; highContrastDark?: string }
  light: string
  dark: string
  /** The web build's Increase Contrast values (prefers-contrast: more), where iOS has its own. */
  contrast?: { light: string; dark: string }
}

export const TOKENS = {
  /** Dims the screen behind a modal while keeping its content readable. */
  scrim: { ios: { light: 'rgba(0, 0, 0, 0.35)', dark: 'rgba(0, 0, 0, 0.6)' }, light: 'rgba(0, 0, 0, 0.35)', dark: 'rgba(0, 0, 0, 0.6)' },
  /** A screen's background. */
  page: { ios: 'systemBackground', light: '#FFFFFF', dark: '#000000' },
  /** A grouped list's background (settings, a bot's page, sheets). */
  grouped: { ios: 'systemGroupedBackground', light: '#F2F2F7', dark: '#000000' },
  /** A card, a row of a grouped list, the composer's field, the title capsule. */
  surface: { ios: 'secondarySystemGroupedBackground', light: '#FFFFFF', dark: '#1C1C1E' },
  /** The bot's message bubble. */
  bubble: { ios: 'secondarySystemBackground', light: '#F2F2F7', dark: '#1C1C1E' },
  /** A chip, a segmented control's track, a switch's off track. */
  chip: { ios: 'tertiarySystemFill', light: '#EBEBF0', dark: 'rgba(118, 118, 128, 0.24)' },
  /** Code in a reply. */
  code: { ios: 'quaternarySystemFill', light: 'rgba(116, 116, 128, 0.08)', dark: 'rgba(118, 118, 128, 0.18)' },
  ink: { ios: 'label', light: '#000000', dark: '#FFFFFF' },
  text: { ios: 'label', light: '#000000', dark: '#FFFFFF' },
  /** On an ink button (its words, a tick): the page's colour, so the pair inverts in dark mode. */
  onInk: { ios: 'systemBackground', light: '#FFFFFF', dark: '#000000' },
  // Web small text clears 4.5:1 on page, grouped, surface and bubble; iOS keeps its dynamic system label.
  secondary: { ios: 'secondaryLabel', light: 'rgba(60, 60, 67, 0.75)', dark: 'rgba(235, 235, 245, 0.6)', contrast: { light: 'rgba(60, 60, 67, 0.9)', dark: 'rgba(235, 235, 245, 0.85)' } },
  /** Icons and disabled fills only; it is under 4.5:1, so no words (placeholders take `secondary`). */
  tertiary: { ios: 'tertiaryLabel', light: 'rgba(60, 60, 67, 0.3)', dark: 'rgba(235, 235, 245, 0.3)' },
  separator: { ios: 'separator', light: 'rgba(60, 60, 67, 0.29)', dark: 'rgba(84, 84, 88, 0.65)' },
  accent: { ios: 'systemBlue', light: '#007AFF', dark: '#0A84FF', contrast: { light: '#0040DD', dark: '#409CFF' } },
  /**
   * A filled accent carrying white words (my bubble, the send button). systemBlue under white
   * reads 4.0:1 in light and 3.7:1 in dark, under the 4.5:1 text minimum, so a deeper blue
   * here (5.3:1), deeper still with Increase Contrast; tinted text and icons keep systemBlue.
   */
  accentFill: { ios: { light: '#0068DA', dark: '#0068DA', highContrastLight: '#0040DD', highContrastDark: '#0050E0' }, light: '#0068DA', dark: '#0068DA', contrast: { light: '#0040DD', dark: '#0050E0' } },
  /** On the accent fill (my bubble, the send button). */
  onAccent: { ios: '#FFFFFF', light: '#FFFFFF', dark: '#FFFFFF' },
  /** A task or thread named in chat, my reaction: the accent at 10% (R-15). */
  objectChip: { ios: { light: 'rgba(0, 122, 255, 0.10)', dark: 'rgba(10, 132, 255, 0.22)', highContrastLight: 'rgba(0, 64, 221, 0.16)', highContrastDark: 'rgba(64, 156, 255, 0.30)' }, light: 'rgba(0, 122, 255, 0.10)', dark: 'rgba(10, 132, 255, 0.22)' },
  unread: { ios: 'systemBlue', light: '#007AFF', dark: '#0A84FF', contrast: { light: '#0040DD', dark: '#409CFF' } },
  success: { ios: 'systemGreen', light: '#34C759', dark: '#30D158', contrast: { light: '#248A3D', dark: '#30DB5B' } },
  danger: { ios: 'systemRed', light: '#D70015', dark: '#FF453A', contrast: { light: '#D70015', dark: '#FF6961' } },
  merged: { ios: 'systemPurple', light: '#AF52DE', dark: '#BF5AF2' },
  prOpen: { ios: 'systemGreen', light: '#34C759', dark: '#30D158' },
  /** An added and a removed line in a diff (#1738): a light wash of green and red, as GitHub draws them. */
  diffAdd: { ios: { light: '#E6FFEC', dark: 'rgba(46, 160, 67, 0.18)' }, light: '#E6FFEC', dark: 'rgba(46, 160, 67, 0.18)' },
  diffDel: { ios: { light: '#FFEBE9', dark: 'rgba(248, 81, 73, 0.18)' }, light: '#FFEBE9', dark: 'rgba(248, 81, 73, 0.18)' },
  orange: { ios: 'systemOrange', light: '#FF9500', dark: '#FF9F0A', contrast: { light: '#C93400', dark: '#FFB340' } },
  /** A pressed or selected row. */
  pressed: { ios: 'systemGray5', light: '#E5E5EA', dark: '#2C2C2E' },
} satisfies Record<string, Token>
