// Which client is running and what only that client can do (ADR 0004,
// docs/design/platforms.md). The web client and the Electron desktop shell
// render the same UI; a capability is on only when the bridge that provides it
// is actually present. Never infer the platform from the user agent.
import type { MikkaBridge } from "./bridge"

export const PLATFORM_RUNTIMES = ["web", "desktop"] as const
export type PlatformRuntime = (typeof PLATFORM_RUNTIMES)[number]

/**
 * Desktop-only abilities. Each one is backed by a `MikkaBridge` subsystem, so
 * a bridge that omits a subsystem also reports the capability as off.
 */
export const DESKTOP_CAPABILITIES = [
  "app.info",
  "notifications.system",
  "notifications.badge",
  "device.localIdentity",
  "device.pickRepo",
  "quota.snapshot",
  "preview.scheme",
  "settings.local",
] as const
export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number]
export type PlatformCapabilities = Readonly<Record<DesktopCapability, boolean>>

export interface PlatformSnapshot {
  readonly runtime: PlatformRuntime
  /** The injected preload bridge; null on the web. */
  readonly bridge: MikkaBridge | null
  readonly capabilities: PlatformCapabilities
}

const NO_CAPABILITIES: PlatformCapabilities = Object.freeze({
  "app.info": false,
  "notifications.system": false,
  "notifications.badge": false,
  "device.localIdentity": false,
  "device.pickRepo": false,
  "quota.snapshot": false,
  "preview.scheme": false,
  "settings.local": false,
})

/** The web client. Always safe: it grants no native ability. */
export const WEB_PLATFORM: PlatformSnapshot = Object.freeze({
  runtime: "web",
  bridge: null,
  capabilities: NO_CAPABILITIES,
})

function isFunction(value: unknown): boolean {
  return typeof value === "function"
}

/**
 * Describes an Electron renderer from its preload bridge. Capabilities follow
 * the methods that are really there, so a shell can ship a smaller surface
 * without the UI claiming a feature it cannot perform.
 */
export function desktopPlatform(bridge: MikkaBridge): PlatformSnapshot {
  return Object.freeze({
    runtime: "desktop",
    bridge,
    capabilities: Object.freeze({
      "app.info": bridge.app.runtime === "electron",
      "notifications.system": isFunction(bridge.notifications?.show),
      "notifications.badge": isFunction(bridge.notifications?.setBadge),
      "device.localIdentity": isFunction(bridge.device?.status),
      "device.pickRepo": isFunction(bridge.device?.pickRepo),
      "quota.snapshot": isFunction(bridge.quota?.get),
      "preview.scheme": isFunction(bridge.preview?.html),
      "settings.local": isFunction(bridge.settings?.getAll),
    }),
  })
}
