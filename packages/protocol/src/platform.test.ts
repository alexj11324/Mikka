// The platform contract: the web client grants nothing, an Electron shell
// grants exactly the capabilities its bridge implements.
import { describe, expect, it } from "vitest"

import type { MikkaBridge } from "./bridge"
import {
  DESKTOP_CAPABILITIES,
  WEB_PLATFORM,
  desktopPlatform,
} from "./platform"

function bridge(overrides: Partial<MikkaBridge> = {}): MikkaBridge {
  return {
    app: {
      version: "0.1.0",
      flavor: "dev",
      runtime: "electron",
      serverUrl: "https://app.example/mikka",
      zeroUrl: "https://zero.example",
    },
    auth: {} as MikkaBridge["auth"],
    settings: { getAll: async () => ({}) as never, set: async () => ({}) as never },
    notifications: {
      show: async () => {},
      setBadge: async () => {},
      onClick: () => () => {},
      consumePendingClick: async () => null,
    },
    device: {
      status: async () => ({
        status: "offline",
        deviceId: null,
        workspaceId: null,
        signedIn: false,
        server: null,
      }),
      link: async () => ({
        status: "offline",
        deviceId: null,
        workspaceId: null,
        signedIn: false,
        server: null,
      }),
      pickRepo: async () => ({ status: "cancelled" }),
    },
    quota: { get: async () => ({ status: "unknown" }) as never },
    preview: { html: async () => "mikka-preview://preview" },
    ...overrides,
  }
}

describe("platform", () => {
  it("the web platform is immutable and grants no desktop capability", () => {
    expect(Object.isFrozen(WEB_PLATFORM)).toBe(true)
    expect(Object.isFrozen(WEB_PLATFORM.capabilities)).toBe(true)
    expect(WEB_PLATFORM.runtime).toBe("web")
    expect(WEB_PLATFORM.bridge).toBeNull()
    for (const capability of DESKTOP_CAPABILITIES) {
      expect(WEB_PLATFORM.capabilities[capability]).toBe(false)
    }
  })

  it("a complete electron bridge reports every capability", () => {
    const platform = desktopPlatform(bridge())
    expect(platform.runtime).toBe("desktop")
    for (const capability of DESKTOP_CAPABILITIES) {
      expect(platform.capabilities[capability]).toBe(true)
    }
  })

  it("a bridge without a subsystem reports only that capability off", () => {
    const platform = desktopPlatform({
      ...bridge(),
      notifications: undefined as never,
      quota: undefined as never,
      preview: undefined as never,
    })
    expect(platform.capabilities["notifications.system"]).toBe(false)
    expect(platform.capabilities["notifications.badge"]).toBe(false)
    expect(platform.capabilities["quota.snapshot"]).toBe(false)
    expect(platform.capabilities["preview.scheme"]).toBe(false)
    expect(platform.capabilities["device.localIdentity"]).toBe(true)
  })

  it("keeps the bridge reachable for callers that implement a feature", () => {
    const injected = bridge()
    expect(desktopPlatform(injected).bridge).toBe(injected)
  })
})
