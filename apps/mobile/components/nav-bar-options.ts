import type { ReactNode } from 'react'

/**
 * The iOS stack options NavBar sets, as plain data so a test can pin them (tests/nav-bar-options.test.mts).
 *
 * As Comma draws it (Alex 2026-11-08): the bar is the page itself, transparent with no material and no hairline;
 * content scrolled under it fades out through the system's soft top edge (iOS 26; TopFade below 26). A tab's root
 * (`topTitle`) has exactly one title, the system's own, centred at the navigation-title size, its buttons grouped
 * on the right and nothing on the left. A custom `titleView` (a chat's name and menu) takes the centre instead.
 */
export function navBarOptions({ title, titleView, large, topTitle }: {
  title?: string
  titleView?: ReactNode
  large?: boolean
  topTitle?: boolean
}) {
  return {
    title: title ?? '',
    headerTitle: !topTitle && titleView ? () => titleView : undefined,
    headerLargeTitle: Boolean(large) && !topTitle,
    headerTransparent: true,
    headerShadowVisible: false,
    scrollEdgeEffects: { top: 'soft' as const, bottom: 'soft' as const },
  }
}

/** iOS before 26 has no soft scroll edge, so the bar draws a short fade from the page colour itself. */
export const needsTopFade = (os: string, version: string | number) => os === 'ios' && Number.parseInt(String(version), 10) < 26
