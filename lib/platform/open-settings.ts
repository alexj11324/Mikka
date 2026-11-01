import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { withBasePath } from '@/lib/base-path'

export type SettingsHandoff = 'browser' | 'desktop' | 'unsupported'

/**
 * Opens a settings section in the system browser from the desktop shell.
 * Account-linking providers must run their OAuth callback in a real browser,
 * so the desktop never starts the link flow in its own window.
 */
export async function openSettingsInBrowser(
  section: 'account' | 'integrations',
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : window as MikkaWindow,
): Promise<SettingsHandoff> {
  return openPathInBrowser(withBasePath(`/?settings=${section}`), target)
}

/** Opens the page the person is on in the system browser, keeping its query. */
export async function openCurrentPageInBrowser(
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : window as MikkaWindow,
): Promise<SettingsHandoff> {
  if (!target) return 'browser'
  const { pathname, search, hash } = target.location
  return openPathInBrowser(`${pathname}${search}${hash}`, target)
}

/** Opens one app path (an OAuth start, say) in the system browser from the desktop shell. */
export async function openPathInBrowser(
  path: string,
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : window as MikkaWindow,
): Promise<SettingsHandoff> {
  if (!target) return 'browser'
  const bridge = bridgeFromWindow(target)
  if (!bridge) return 'browser'
  if (typeof bridge.app.openExternal !== 'function') return 'unsupported'
  const url = new URL(path, target.location.origin)
  await bridge.app.openExternal(url.toString())
  return 'desktop'
}
