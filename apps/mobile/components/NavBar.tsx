import type { ComponentProps, ReactNode } from 'react'
import { Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { BackButton, Header, RoundButton } from '@/components/ui'

/** An SF Symbol name, as the toolbar takes it. */
type SFSymbol = Extract<NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']>, string>

export type BarButton = { icon: SFSymbol; label: string; onPress: () => void; web: ReactNode }
export type BarMenu = { icon: SFSymbol; label: string; web: ReactNode; onOpen: () => void; items: { label: string; icon: SFSymbol; on: boolean; onPress: () => void }[] }

const ios = Platform.OS === 'ios'

/**
 * The screen's top bar. On iOS it is the system navigation bar: transparent
 * over the content with the system's scroll-edge effect, its buttons and menus
 * UIKit bar items (Liquid Glass on iOS 26), and the system back button and
 * swipe on pushed pages. The web build, used for screenshot checks, draws the
 * same bar in React Native (`Header`).
 *
 * A screen's scroll view sets `contentInsetAdjustmentBehavior="automatic"` so
 * its content starts below the bar and scrolls under it.
 */
export function NavBar({ title, titleView, left, right, back }: { title?: string; titleView?: ReactNode; left?: BarButton; right?: BarButton | BarMenu; back?: () => void }) {
  const router = useRouter()
  if (!ios) {
    const goBack = back ?? (() => router.back())
    return (
      <Header
        left={left ? <RoundButton label={left.label} onPress={left.onPress}>{left.web}</RoundButton> : back !== undefined ? <BackButton onPress={goBack} /> : undefined}
        title={titleView ?? title}
        right={right ? <RoundButton label={right.label} onPress={'items' in right ? right.onOpen : right.onPress}>{right.web}</RoundButton> : <></>}
      />
    )
  }
  return (
    <>
      <Stack.Screen options={{ title: title ?? '', headerTitle: titleView ? () => titleView : undefined }} />
      {left ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button icon={left.icon} accessibilityLabel={left.label} onPress={left.onPress} />
        </Stack.Toolbar>
      ) : null}
      {right ? (
        <Stack.Toolbar placement="right">
          {'items' in right ? (
            <Stack.Toolbar.Menu icon={right.icon} accessibilityLabel={right.label}>
              {right.items.map(item => <Stack.Toolbar.MenuAction key={item.label} icon={item.icon} isOn={item.on} onPress={item.onPress}>{item.label}</Stack.Toolbar.MenuAction>)}
            </Stack.Toolbar.Menu>
          ) : <Stack.Toolbar.Button icon={right.icon} accessibilityLabel={right.label} onPress={right.onPress} />}
        </Stack.Toolbar>
      ) : null}
    </>
  )
}

/** Scroll view props that put content below a transparent iOS bar; the web bar takes its own space. */
export const underBar = ios ? { contentInsetAdjustmentBehavior: 'automatic' as const } : {}
