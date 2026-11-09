import type { ComponentProps, ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, usePathname, useRouter } from 'expo-router'
import { BackButton, Header, RoundButton } from '@/components/ui'
import { Text } from '@/components/Text'
import { colors, font } from '@/lib/theme'
import { WebBarMenu } from '@/components/WebBarMenu'
import { BarBackdrop } from '@/components/BarBackdrop'
import { navBarOptions, needsTopFade } from '@/components/nav-bar-options'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

/** An SF Symbol name, as the toolbar takes it. */
type SFSymbol = Extract<NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']>, string>

/** A bar button: an icon, or with `text` a word (编辑, 完成); `prominent` fills it with the accent (a sheet's ✓). */
export type BarButton = { icon: SFSymbol; label: string; onPress: () => void; web: ReactNode; disabled?: boolean; busy?: boolean; text?: string; prominent?: boolean }
/** A bar menu: an icon button, or with `text` a text button with a chevron (the workspace switcher); `plain` draws `web` as it is. */
export type BarMenu = { icon: SFSymbol; label: string; web: ReactNode; onOpen: () => void; items: { label: string; icon?: SFSymbol; on?: boolean; onPress: () => void }[]; text?: string; plain?: boolean }
/** A drawn item, such as the person's avatar; it fills its own circle, without the bar's glass behind it. */
export type BarView = { label: string; view: ReactNode; onPress: () => void }
type BarItem = BarButton | BarMenu | BarView
const list = (items?: BarItem | BarItem[]) => items === undefined ? [] : Array.isArray(items) ? items : [items]

const ios = Platform.OS === 'ios'
const TAB_ROOTS = new Set(['/', '/tasks', '/suggestions', '/settings', '/search'])

// A plain function, not a component: the toolbar keeps only children whose type is Stack.Toolbar.Button or
// Stack.Toolbar.Menu itself, and silently drops anything wrapped in another component.
function nativeItem(item: BarItem) {
  if ('view' in item) {
    return (
      <Stack.Toolbar.View key={item.label} hidesSharedBackground>
        <Pressable accessibilityRole="button" accessibilityLabel={item.label} onPress={item.onPress} style={styles.viewButton}>{item.view}</Pressable>
      </Stack.Toolbar.View>
    )
  }
  if ('items' in item && item.text) {
    return (
      <Stack.Toolbar.Menu key={item.label} accessibilityLabel={item.label}>
        <Stack.Toolbar.Label>{item.text}</Stack.Toolbar.Label>
        <Stack.Toolbar.Icon sf="chevron.down" />
        {item.items.map(entry => <Stack.Toolbar.MenuAction key={entry.label} icon={entry.icon} isOn={entry.on} onPress={entry.onPress}>{entry.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
    )
  }
  if ('items' in item) {
    return (
      <Stack.Toolbar.Menu key={item.label} icon={item.icon} accessibilityLabel={item.label}>
        {item.items.map(entry => <Stack.Toolbar.MenuAction key={entry.label} icon={entry.icon} isOn={entry.on} onPress={entry.onPress}>{entry.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
    )
  }
  if (item.text) return <Stack.Toolbar.Button key={item.label} accessibilityLabel={item.label} disabled={item.disabled || item.busy} onPress={item.onPress}>{item.text}</Stack.Toolbar.Button>
  return <Stack.Toolbar.Button key={item.label} icon={item.busy ? 'hourglass' : item.icon} accessibilityLabel={item.label} disabled={item.disabled || item.busy} onPress={item.onPress} variant={item.prominent ? 'prominent' : undefined} />
}

const webItem = (item: BarItem) => 'view' in item
  ? <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={item.onPress} style={styles.viewButton}>{item.view}</Pressable>
  : 'items' in item && Platform.OS === 'web'
    ? <WebBarMenu key={item.label} item={item} plain={item.plain} />
    : <RoundButton key={item.label} label={item.label} disabled={'disabled' in item && item.disabled} busy={'busy' in item && item.busy} onPress={'items' in item ? item.onOpen : item.onPress}>{item.web}</RoundButton>

/**
 * The screen's top bar. On iOS it is the system navigation bar: transparent
 * over the content with the system's scroll-edge effect, its buttons and menus
 * UIKit bar items (Liquid Glass on iOS 26), the system back button and swipe
 * on pushed pages, a large title where `large`, one centred title with the
 * buttons grouped on the right where `topTitle` (a tab's root), and the
 * system search field where `search`. The web build, used for screenshot checks, draws the same
 * bar in React Native (`Header`).
 *
 * A screen's scroll view sets `contentInsetAdjustmentBehavior="automatic"` so
 * its content starts below the bar and scrolls under it. The bar has no
 * material or hairline (Comma, Alex 2026-11-08): content fades out under the top
 * edge, by the system's soft scroll edge on iOS 26 and `TopFade` below it.
 */
export function NavBar({ title, titleView, left, right, back, large, topTitle, search, background = colors.page, fade = true, sheet, scrolled }: {
  title?: string
  /** A tab's root (Bot, 任务, 建议, 设置, 搜索): one title, the system's, centred in the bar's row; the buttons grouped
   * on the right; nothing on the left (Alex 2026-11-08, after 「Bot」 showed twice). */
  topTitle?: boolean
  titleView?: ReactNode
  left?: BarItem | BarItem[]
  right?: BarItem | BarItem[]
  back?: () => void
  large?: boolean
  search?: { placeholder: string; onChange: (text: string) => void }
  /** The page colour the bar fades from below iOS 26 (settings is grouped). */
  background?: string
  /** False under an opaque header (a form sheet's), where nothing scrolls beneath it. */
  fade?: boolean
  /** A form sheet: closed by its own ✕ or ✓ and by swiping down, so no back button beside them. */
  sheet?: boolean
  /** A conversation scrolling under the bar (useScrolledUnderBar): the bar gets its material backdrop (BarBackdrop)
   * once content is under it, on every iOS version, instead of relying on the system's soft edge alone. */
  scrolled?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  // A tab's root page has no back button, and its title is large under the bar (the web build has no tab bar).
  const webTabRoot = Platform.OS === 'web' && TAB_ROOTS.has(pathname)
  const lefts = list(left), rights = list(right)
  if (!ios) {
    const goBack = back ?? (() => {
      if (Platform.OS === 'web' && !router.canGoBack()) router.replace('/')
      else router.back()
    })
    // The Web router's history availability is not reactive. Keep an exit on pushed/deep-linked pages.
    const showBack = !sheet && (Platform.OS === 'web' || back !== undefined || router.canGoBack())
    if (topTitle) return (
      <>
        <TopRow title={title ?? ''} right={rights.map(webItem)} />
        {search ? <View style={styles.search}>
          <TextInput accessibilityLabel={search.placeholder} role="searchbox" placeholder={search.placeholder}
            placeholderTextColor={colors.secondary} onChangeText={search.onChange} autoCapitalize="none" autoCorrect={false}
            returnKeyType="search" clearButtonMode="while-editing" style={styles.searchInput} />
        </View> : null}
      </>
    )
    return (
      <>
        <Header
          left={lefts.length ? lefts.map(webItem) : webTabRoot ? <View style={styles.viewButton} /> : showBack ? <BackButton onPress={goBack} /> : undefined}
          title={large ? undefined : titleView ?? title}
          right={rights.length ? rights.map(webItem) : <></>}
        />
        {large && title ? <Text accessibilityRole="header" style={styles.largeTitle}>{title}</Text> : null}
        {search ? <View style={styles.search}>
          <TextInput accessibilityLabel={search.placeholder} role="searchbox" placeholder={search.placeholder}
            placeholderTextColor={colors.secondary} onChangeText={search.onChange} autoCapitalize="none" autoCorrect={false}
            returnKeyType="search" clearButtonMode="while-editing" style={styles.searchInput} />
        </View> : null}
      </>
    )
  }
  return (
    <>
      <Stack.Screen options={{
        ...navBarOptions({ title, titleView, large, topTitle }),
        ...(search ? { headerSearchBarOptions: { placeholder: search.placeholder, hideWhenScrolling: false, onChangeText: event => search.onChange(event.nativeEvent.text), onCancelButtonPress: () => search.onChange('') } } : {}),
      }} />
      {!topTitle && lefts.length ? <Stack.Toolbar placement="left">{lefts.map(nativeItem)}</Stack.Toolbar> : null}
      {rights.length ? <Stack.Toolbar placement="right">{rights.map(nativeItem)}</Stack.Toolbar> : null}
      {scrolled !== undefined ? <BarBackdrop visible={scrolled} />
        : fade && needsTopFade(Platform.OS, Platform.Version) ? <TopFade color={background} /> : null}
    </>
  )
}

/** The web build's top row for a tab's root, as iOS draws it: one title centred, the buttons on the right. */
function TopRow({ title, right }: { title: string; right: ReactNode[] }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.topRow, { paddingTop: insets.top + 6 }]}>
      <Text accessibilityRole="header" numberOfLines={1} style={styles.topTitle}>{title}</Text>
      <View style={styles.topButtons}>{right}</View>
    </View>
  )
}

/**
 * The top of a chat's list on the web build, where the bar sits above the list rather than over it: messages scrolled
 * up dissolve into the page colour under the title pill instead of being cut at the bar's edge. iOS has the system's
 * soft scroll edge (26) or TopFade (earlier) for this.
 */
export function ListTopFade({ color, height = 28 }: { color: string; height?: number }) {
  if (Platform.OS !== 'web') return null
  return (
    <View pointerEvents="none" style={[styles.listFade, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="listFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill="url(#listFade)" />
      </Svg>
    </View>
  )
}

/** Below iOS 26: the page colour fading out under the bar, so rows scrolled up never run into its title or buttons. */
function TopFade({ color }: { color: string }) {
  const insets = useSafeAreaInsets()
  const height = insets.top + 44 + 20
  return (
    <View pointerEvents="none" style={[styles.fade, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="navFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset={String((insets.top + 44) / height)} stopColor={color} stopOpacity={0.85} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill="url(#navFade)" />
      </Svg>
    </View>
  )
}

/** Scroll view props that put content below a transparent iOS bar; the web bar takes its own space. */
export const underBar = ios ? { contentInsetAdjustmentBehavior: 'automatic' as const } : {}

const styles = StyleSheet.create({
  largeTitle: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8, fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.4, color: colors.text },
  viewButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  /** A tab root's title: the system navigation title (17 pt semibold), centred in the row. */
  topTitle: { position: 'absolute', left: 96, right: 96, bottom: 8, textAlign: 'center', fontSize: 17, lineHeight: 28, fontWeight: '600', color: colors.text },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 16, paddingBottom: 6, minHeight: 50 },
  topButtons: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  fade: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  listFade: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  search: { paddingHorizontal: 16, paddingBottom: 12 },
  searchInput: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.bubble, color: colors.text, fontFamily: font, fontSize: 16 },
})
