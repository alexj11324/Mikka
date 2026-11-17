import type { BrowserWindowConstructorOptions } from 'electron'

type Appearance = Pick<BrowserWindowConstructorOptions, 'backgroundColor' | 'titleBarStyle' | 'trafficLightPosition'>

/**
 * The main window's frame: always opaque, with no vibrancy material
 * (decision 2026-11-17-1500). macOS keeps the inset traffic lights over the
 * page's own top bar; Windows and Linux keep the native title bar.
 */
export function windowAppearance(platform: NodeJS.Platform, { dark }: { dark: boolean }): Appearance {
  const backgroundColor = dark ? '#000000' : '#f5f5f4'
  if (platform !== 'darwin') return { backgroundColor }
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, backgroundColor }
}
