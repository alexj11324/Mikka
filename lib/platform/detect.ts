import { WEB_PLATFORM, desktopPlatform, type PlatformSnapshot } from '@mikka/protocol/platform'
import type { MikkaBridge } from '@mikka/protocol/bridge'

/** The window a desktop preload extends with `window.mikka`. */
export type MikkaWindow = Window & { mikka?: MikkaBridge }

/**
 * The bridge, only when it declares the Electron runtime. A page can assign
 * `window.mikka` itself, but that grants no native power: the main process
 * validates the sender and every payload on each IPC call.
 */
export function bridgeFromWindow(target?: MikkaWindow | null): MikkaBridge | null {
  const bridge = target?.mikka
  if (!bridge || bridge.app?.runtime !== 'electron') return null
  return bridge
}

export function platformFromBridge(bridge: MikkaBridge | null | undefined): PlatformSnapshot {
  return bridge ? desktopPlatform(bridge) : WEB_PLATFORM
}

/** Synchronous platform detection. `window` is absent during server rendering. */
export function detectPlatform(
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : (window as MikkaWindow)
): PlatformSnapshot {
  return platformFromBridge(bridgeFromWindow(target))
}
