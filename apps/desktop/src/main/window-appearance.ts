import type { BrowserWindowConstructorOptions } from 'electron'

/** Passed to the preload, which marks the page so the rail and list let the window's material show through. */
export const TRANSLUCENT_ARGUMENT = '--mikka-translucent'

type Appearance = Pick<BrowserWindowConstructorOptions, 'backgroundColor' | 'titleBarStyle' | 'trafficLightPosition' | 'vibrancy' | 'visualEffectState'>

/**
 * The main window's frame. On macOS the window is the sidebar material, as in
 * Codex: the page paints its content opaque and leaves the rail and list
 * translucent. Reduce transparency (System Settings › Accessibility › Display)
 * keeps the opaque window. Windows and Linux keep the opaque window.
 */
export function windowAppearance(platform: NodeJS.Platform, { dark, reduceTransparency }: { dark: boolean; reduceTransparency: boolean }): { options: Appearance; translucent: boolean } {
  const opaque = dark ? '#000000' : '#f5f5f4'
  if (platform !== 'darwin') return { options: { backgroundColor: opaque }, translucent: false }
  const frame = { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
  if (reduceTransparency) return { options: { ...frame, backgroundColor: opaque }, translucent: false }
  return { options: { ...frame, backgroundColor: '#00000000', vibrancy: 'sidebar', visualEffectState: 'followWindow' }, translucent: true }
}
