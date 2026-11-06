import { DynamicColorIOS, Platform, PlatformColor } from 'react-native'
import { TOKENS, type Token } from './tokens'

/**
 * The app's colours. On iOS each one is a system colour (PlatformColor), so it
 * follows light and dark mode and Increase Contrast by itself (Alex,
 * 2026-11-02); the few with no system name (an accent tint) are a
 * DynamicColorIOS with light, dark and high-contrast values. The web build
 * (screenshot checks) reads CSS variables that switch with
 * prefers-color-scheme; Android has the light values. Every value is typed as
 * a string, since components take colours that way; on iOS it is an opaque
 * colour object, so never build strings from it.
 */
type Name = keyof typeof TOKENS

function resolve(name: Name, token: Token): string {
  if (Platform.OS === 'ios') return (typeof token.ios === 'string' && token.ios.startsWith('#') ? token.ios : typeof token.ios === 'string' ? PlatformColor(token.ios) : DynamicColorIOS(token.ios)) as unknown as string
  if (Platform.OS === 'web') return `var(--mk-${name})`
  return token.light
}

/**
 * Side margins (Alex 2026-11-06; HIG layout margins): a plain list's content starts 16 pt in from each edge, an inset
 * grouped list's cards 20 pt. A row's pressed surface sits 6 pt in and its content 10 pt further, so text lands on 16.
 */
export const LIST_INSET = 16
export const GROUP_INSET = 20
export const ROW_SURFACE_INSET = 6

export const colors = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) => [name, resolve(name as Name, token)])) as Record<Name, string>

// The web build's palette, switched by the browser's colour scheme.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const tokens: [string, Token][] = Object.entries(TOKENS)
  const vars = (scheme: 'light' | 'dark', contrast = false) => tokens
    .flatMap(([name, token]) => contrast ? token.contrast ? [`--mk-${name}: ${token.contrast[scheme]};`] : [] : [`--mk-${name}: ${token[scheme]};`]).join(' ')
  const style = document.createElement('style')
  style.textContent = `:root { ${vars('light')} color-scheme: light dark; } @media (prefers-color-scheme: dark) { :root { ${vars('dark')} } }`
    + ` @media (prefers-contrast: more) { :root { ${vars('light', true)} } } @media (prefers-contrast: more) and (prefers-color-scheme: dark) { :root { ${vars('dark', true)} } }`
    + ' body { background: var(--mk-page); }'
    + ' :is(input, textarea, button, [tabindex]):focus-visible { outline: 2px solid var(--mk-accent) !important; outline-offset: 3px; }'
  document.head.appendChild(style)
}

/** The light or dark value of a token, for the few places that build a colour string (a CSS gradient). */
export const plainColor = (name: Name, scheme: 'light' | 'dark') => TOKENS[name][scheme]

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
