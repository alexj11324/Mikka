import type { ComponentProps, ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Stack, usePathname, useRouter } from 'expo-router'
import { BackButton, Header, RoundButton } from '@/components/ui'
import { colors, font } from '@/lib/theme'
import { WebBarMenu } from '@/components/WebBarMenu'

/** An SF Symbol name, as the toolbar takes it. */
type SFSymbol = Extract<NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']>, string>

export type BarButton = { icon: SFSymbol; label: string; onPress: () => void; web: ReactNode; disabled?: boolean; busy?: boolean }
export type BarMenu = { icon: SFSymbol; label: string; web: ReactNode; onOpen: () => void; items: { label: string; icon: SFSymbol; on?: boolean; onPress: () => void }[] }
/** A drawn item, such as the person's avatar; it fills its own circle, without the bar's glass behind it. */
export type BarView = { label: string; view: ReactNode; onPress: () => void }
type BarItem = BarButton | BarMenu | BarView
const list = (items?: BarItem | BarItem[]) => items === undefined ? [] : Array.isArray(items) ? items : [items]

const ios = Platform.OS === 'ios'

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
  if ('items' in item) {
    return (
      <Stack.Toolbar.Menu key={item.label} icon={item.icon} accessibilityLabel={item.label}>
        {item.items.map(entry => <Stack.Toolbar.MenuAction key={entry.label} icon={entry.icon} isOn={entry.on} onPress={entry.onPress}>{entry.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
    )
  }
  return <Stack.Toolbar.Button key={item.label} icon={item.busy ? 'hourglass' : item.icon} accessibilityLabel={item.label} disabled={item.disabled || item.busy} onPress={item.onPress} />
}

const webItem = (item: BarItem) => 'view' in item
  ? <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={item.onPress} style={styles.viewButton}>{item.view}</Pressable>
  : 'items' in item && Platform.OS === 'web'
    ? <WebBarMenu key={item.label} item={item} />
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
  // Expo Web already names these roots in its floating native-tab fallback.
  const webTabRoot = Platform.OS === 'web' && ['/chats', '/threads', '/search'].includes(pathname)
  const lefts = list(left), rights = list(right)
  if (!ios) {
    const goBack = back ?? (() => {
      if (Platform.OS === 'web' && !router.canGoBack()) router.replace('/chats')
      else router.back()
    })
    // The Web router's history availability is not reactive. Keep an exit on pushed/deep-linked pages.
    const showBack = Platform.OS === 'web' || back !== undefined || router.canGoBack()
    return (
      <>
        <Header
          style={webTabRoot ? styles.webTabHeader : undefined}
          left={lefts.length ? lefts.map(webItem) : webTabRoot ? <View style={styles.viewButton} /> : showBack ? <BackButton onPress={goBack} /> : undefined}
          title={webTabRoot ? undefined : titleView ?? title}
          right={rights.length ? rights.map(webItem) : <></>}
        />
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
  webTabHeader: { paddingBottom: 24 },
  viewButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  search: { paddingHorizontal: 16, paddingBottom: 12 },
  searchInput: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.bubble, color: colors.text, fontFamily: font, fontSize: 16 },
})
