'use client'

import { useSyncExternalStore } from 'react'

import { WEB_PLATFORM, type DesktopCapability, type PlatformSnapshot } from '@mikka/protocol/platform'

import { detectPlatform } from './detect'

/**
 * The bridge is injected before the page scripts run and never changes, so one
 * cached snapshot per page load is enough. Caching it also gives
 * `useSyncExternalStore` the stable value it requires.
 */
let cached: PlatformSnapshot | undefined
function snapshot(): PlatformSnapshot {
  return (cached ??= detectPlatform())
}

const subscribe = () => () => {}
const serverSnapshot = () => WEB_PLATFORM

/**
 * The client the page runs in. Server rendering and the hydration pass use
 * the web snapshot; a desktop shell re-renders as desktop right after
 * hydration. Do not branch on this before mount.
 */
export function usePlatform(): PlatformSnapshot {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/** True only when this client is the desktop shell and it reports `capability`. */
export function useDesktopCapability(capability: DesktopCapability): boolean {
  const platform = usePlatform()
  return platform.runtime === 'desktop' && platform.capabilities[capability]
}
