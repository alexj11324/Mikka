import { Platform } from 'react-native'

/** Colours from the mobile Figma frames (page 268:4750). Colour is restrained (mobile.md). */
export const colors = {
  page: '#FFFFFF',
  grouped: '#F2F2F7',
  surface: '#FFFFFF',
  bubble: '#F2F2F2',
  chip: '#EBEBEB',
  ink: '#111111',
  text: '#1C1C1E',
  secondary: '#8A8A8E',
  tertiary: '#B0B0B5',
  separator: '#E5E5EA',
  accent: '#3478F6',
  /** A task or thread named in chat: the accent at 10% (R-15). */
  objectChip: 'rgba(52, 120, 246, 0.10)',
  unread: '#3478F6',
  success: '#34C759',
  danger: '#E5484D',
  merged: '#8250DF',
  prOpen: '#1A7F37',
  orange: '#E8840C',
  pressed: '#E8E8EA',
} as const

export const font = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", "WenQuanYi Zen Hei", system-ui, sans-serif',
  default: undefined,
})

/** A soft lift instead of an outline: cards and floating buttons have no stroke (decisions 2026-10-27). */
export const lift = {
  shadowColor: '#000',
  shadowOpacity: 0.08,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 2 },
  elevation: 3,
} as const

/**
 * Stack options: on iOS the system navigation bar, transparent over the
 * content (each screen fills it with `NavBar`), the back button as a bare
 * chevron and the system push and swipe back; the web draws its own bar.
 */
export const screenOptions = (background: string) => ({
  headerShown: Platform.OS === 'ios',
  headerTransparent: true,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal' as const,
  headerTintColor: colors.ink,
  // iOS 26 blurs content scrolling under the bar (and above the home indicator) with the system's soft edge.
  scrollEdgeEffects: { top: 'soft' as const, bottom: 'soft' as const },
  contentStyle: { backgroundColor: background },
  ...(Platform.OS === 'ios' ? {} : { animation: 'slide_from_right' as const }),
})
