import type { ComponentProps, ReactNode } from 'react'
import { Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { BackButton, Header, RoundButton } from '@/components/ui'

/** An SF Symbol name, as the toolbar takes it. */
type SFSymbol = Extract<NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']>, string>

export type BarButton = { icon: SFSymbol; label: string; onPress: () => void; web: ReactNode }
export type BarMenu = { icon: SFSymbol; label: string; web: ReactNode; onOpen: () => void; items: { label: string; icon: SFSymbol; on?: boolean; onPress: () => void }[] }
type BarItem = BarButton | BarMenu
const list = (items?: BarItem | BarItem[]) => items === undefined ? [] : Array.isArray(items) ? items : [items]

const ios = Platform.OS === 'ios'

function NativeItem({ item }: { item: BarItem }) {
  if ('items' in item) {
    return (
      <Stack.Toolbar.Menu icon={item.icon} accessibilityLabel={item.label}>
        {item.items.map(entry => <Stack.Toolbar.MenuAction key={entry.label} icon={entry.icon} isOn={entry.on} onPress={entry.onPress}>{entry.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
    )
  }
  return <Stack.Toolbar.Button icon={item.icon} accessibilityLabel={item.label} onPress={item.onPress} />
}

const webItem = (item: BarItem) => <RoundButton key={item.label} label={item.label} onPress={'items' in item ? item.onOpen : item.onPress}>{item.web}</RoundButton>

/**
 * The screen's top bar. On iOS it is the system navigation bar: transparent
 * over the content with the system's scroll-edge effect, its buttons and menus
 * UIKit bar items (Liquid Glass on iOS 26), the system back button and swipe
 * on pushed pages, a large title where `large`, and the system search field
 * where `search`. The web build, used for screenshot checks, draws the same
 * bar in React Native (`Header`).
 *
 * A screen's scroll view sets `contentInsetAdjustmentBehavior="automatic"` so
 * its content starts below the bar and scrolls under it.
 */
export function NavBar({ title, titleView, left, right, back, large, search }: {
  title?: string
  titleView?: ReactNode
  left?: BarItem | BarItem[]
  right?: BarItem | BarItem[]
  back?: () => void
  large?: boolean
  search?: { placeholder: string; onChange: (text: string) => void }
}) {
  const router = useRouter()
  const lefts = list(left), rights = list(right)
  if (!ios) {
    const goBack = back ?? (() => router.back())
    return (
      <Header
        left={lefts.length ? lefts.map(webItem) : back !== undefined || router.canGoBack() ? <BackButton onPress={goBack} /> : undefined}
        title={titleView ?? title}
        right={rights.length ? rights.map(webItem) : <></>}
      />
    )
  }
  return (
    <>
      <Stack.Screen options={{
        title: title ?? '',
        headerTitle: titleView ? () => titleView : undefined,
        headerLargeTitle: large,
        ...(search ? { headerSearchBarOptions: { placeholder: search.placeholder, hideWhenScrolling: false, onChangeText: event => search.onChange(event.nativeEvent.text), onCancelButtonPress: () => search.onChange('') } } : {}),
      }} />
      {lefts.length ? <Stack.Toolbar placement="left">{lefts.map(item => <NativeItem key={item.label} item={item} />)}</Stack.Toolbar> : null}
      {rights.length ? <Stack.Toolbar placement="right">{rights.map(item => <NativeItem key={item.label} item={item} />)}</Stack.Toolbar> : null}
    </>
  )
}

/** Scroll view props that put content below a transparent iOS bar; the web bar takes its own space. */
export const underBar = ios ? { contentInsetAdjustmentBehavior: 'automatic' as const } : {}
