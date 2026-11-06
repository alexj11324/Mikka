import type { ComponentProps, ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Stack, usePathname, useRouter } from 'expo-router'
import { BackButton, Header, RoundButton } from '@/components/ui'
import { Text } from '@/components/Text'
import { colors, font } from '@/lib/theme'
import { WebBarMenu } from '@/components/WebBarMenu'

/** An SF Symbol name, as the toolbar takes it. */
type SFSymbol = Extract<NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']>, string>

/** A bar button: an icon, or with `text` a word (编辑, 完成). */
export type BarButton = { icon: SFSymbol; label: string; onPress: () => void; web: ReactNode; disabled?: boolean; busy?: boolean; text?: string }
/** A bar menu: an icon button, or with `text` a text button with a chevron (the workspace switcher); `plain` draws `web` as it is. */
export type BarMenu = { icon: SFSymbol; label: string; web: ReactNode; onOpen: () => void; items: { label: string; icon?: SFSymbol; on?: boolean; onPress: () => void }[]; text?: string; plain?: boolean }
/** A drawn item, such as the person's avatar; it fills its own circle, without the bar's glass behind it. */
export type BarView = { label: string; view: ReactNode; onPress: () => void }
type BarItem = BarButton | BarMenu | BarView
const list = (items?: BarItem | BarItem[]) => items === undefined ? [] : Array.isArray(items) ? items : [items]

const ios = Platform.OS === 'ios'
const TAB_ROOTS = new Set(['/', '/threads', '/suggestions', '/settings', '/search'])

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
  return <Stack.Toolbar.Button key={item.label} icon={item.busy ? 'hourglass' : item.icon} accessibilityLabel={item.label} disabled={item.disabled || item.busy} onPress={item.onPress} />
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
 * on pushed pages, a large title where `large`, and the system search field
 * where `search`. The web build, used for screenshot checks, draws the same
 * bar in React Native (`Header`).
 *
 * A screen's scroll view sets `contentInsetAdjustmentBehavior="automatic"` so
 * its content starts below the bar and scrolls under it. `material` gives the
 * bar the system chrome material and a hairline, so long text scrolled under it
 * never shows through on any iOS version (Figma 843:2 #4; chats).
 */
export function NavBar({ title, titleView, left, right, back, large, search, material }: {
  title?: string
  titleView?: ReactNode
  left?: BarItem | BarItem[]
  right?: BarItem | BarItem[]
  back?: () => void
  large?: boolean
  search?: { placeholder: string; onChange: (text: string) => void }
  material?: boolean
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
    const showBack = Platform.OS === 'web' || back !== undefined || router.canGoBack()
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
        title: title ?? '',
        headerTitle: titleView ? () => titleView : undefined,
        headerLargeTitle: large,
        ...(material ? { headerBlurEffect: 'systemChromeMaterial' as const, headerShadowVisible: true, scrollEdgeEffects: { top: 'hidden' as const, bottom: 'soft' as const } } : {}),
        ...(search ? { headerSearchBarOptions: { placeholder: search.placeholder, hideWhenScrolling: false, onChangeText: event => search.onChange(event.nativeEvent.text), onCancelButtonPress: () => search.onChange('') } } : {}),
      }} />
      {lefts.length ? <Stack.Toolbar placement="left">{lefts.map(nativeItem)}</Stack.Toolbar> : null}
      {rights.length ? <Stack.Toolbar placement="right">{rights.map(nativeItem)}</Stack.Toolbar> : null}
    </>
  )
}

/** Scroll view props that put content below a transparent iOS bar; the web bar takes its own space. */
export const underBar = ios ? { contentInsetAdjustmentBehavior: 'automatic' as const } : {}

const styles = StyleSheet.create({
  largeTitle: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8, fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.4, color: colors.text },
  viewButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  search: { paddingHorizontal: 16, paddingBottom: 12 },
  searchInput: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.bubble, color: colors.text, fontFamily: font, fontSize: 16 },
})
