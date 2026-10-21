import { describe, expect, it, vi } from "vitest"

import { createAnalytics, type AnalyticsClient } from "./analytics-client"

const CONTEXT = { flavor: "prod", version: "0.0.1", runtime: "electron" }
const USER = {
  id: "0d9a3a54-6a52-4f0b-8f0f-2f3a9e7a1c11",
  email: "alex@example.com",
  name: "Alex",
  image: null,
}

function fakeClient() {
  return {
    capture: vi.fn<AnalyticsClient["capture"]>(),
    identify: vi.fn<AnalyticsClient["identify"]>(),
    reset: vi.fn<AnalyticsClient["reset"]>(),
    opt_in_capturing: vi.fn<AnalyticsClient["opt_in_capturing"]>(),
    opt_out_capturing: vi.fn<AnalyticsClient["opt_out_capturing"]>(),
    isFeatureEnabled: vi.fn<NonNullable<AnalyticsClient["isFeatureEnabled"]>>(),
    onFeatureFlags: vi.fn<NonNullable<AnalyticsClient["onFeatureFlags"]>>(
      () => () => {}
    ),
  } satisfies AnalyticsClient
}

describe("track", () => {
  it("captures with the build context and drops unsafe properties", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.track("run_started", {
      harness: "claude_code",
      source: "fix the bug in /Users/alex/app.ts",
    })
    expect(client.capture).toHaveBeenCalledWith("run_started", {
      ...CONTEXT,
      harness: "claude_code",
    })
  })

  it("sends nothing while usage data is off, and turning it on resumes", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, false)
    expect(client.opt_out_capturing).toHaveBeenCalled()
    analytics.track("app_opened")
    expect(client.capture).not.toHaveBeenCalled()
    analytics.setEnabled(true)
    analytics.track("app_opened")
    expect(client.opt_in_capturing).toHaveBeenCalledWith({
      captureEventName: false,
    })
    expect(client.capture).toHaveBeenCalledTimes(1)
  })

  it("turning it off forgets the identity", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.onAuthState({ status: "signed_in", user: USER })
    analytics.setEnabled(false)
    expect(client.opt_out_capturing).toHaveBeenCalled()
    expect(client.reset).toHaveBeenCalled()
  })

  it("is a no-op without a client", () => {
    const analytics = createAnalytics(null, CONTEXT, true)
    expect(() => {
      analytics.track("app_opened")
      analytics.onAuthState({ status: "signed_in", user: USER })
      analytics.setEnabled(false)
    }).not.toThrow()
    expect(analytics.isFlagEnabled("ui-usage")).toBe(false)
  })
})

describe("onAuthState", () => {
  it("identifies by account id only and does not call a restored session a sign-in", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.onAuthState({ status: "signed_in", user: USER })
    analytics.onAuthState({ status: "signed_in", user: USER })
    expect(client.identify).toHaveBeenCalledTimes(1)
    expect(client.identify).toHaveBeenCalledWith(USER.id)
    expect(client.capture).not.toHaveBeenCalled()
  })

  it("reports the sign-in funnel", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.onAuthState({ status: "signed_out" })
    analytics.onAuthState({ status: "signing_in", provider: "github" })
    analytics.onAuthState({ status: "signed_in", user: USER })
    analytics.onAuthState({ status: "signed_out" })
    expect(client.capture.mock.calls.map(([event]) => event)).toEqual([
      "sign_in_started",
      "signed_in",
      "signed_out",
    ])
    expect(client.capture.mock.calls[1]?.[1]).toMatchObject({
      provider: "github",
    })
    expect(client.reset).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(client.capture.mock.calls)).not.toContain("alex")
  })

  it("reports a failed sign-in with its code, and an update gate", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.onAuthState({ status: "signing_in", provider: "google" })
    analytics.onAuthState({ status: "error", code: "login_cancelled" })
    analytics.onAuthState({ status: "update_required", minVersion: "0.1.0" })
    expect(client.capture.mock.calls.map(([event]) => event)).toEqual([
      "sign_in_started",
      "sign_in_failed",
      "update_required",
    ])
    expect(client.capture.mock.calls[1]?.[1]).toMatchObject({
      provider: "google",
      reason: "login_cancelled",
    })
  })

  it("does not call an error at launch a failed sign-in", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    analytics.onAuthState({ status: "error", code: "network" })
    expect(client.capture).not.toHaveBeenCalled()
  })
})

describe("feature flags", () => {
  it("is off until PostHog says on", () => {
    const client = fakeClient()
    const analytics = createAnalytics(client, CONTEXT, true)
    expect(analytics.isFlagEnabled("ui-usage")).toBe(false)
    client.isFeatureEnabled.mockReturnValue(true)
    expect(analytics.isFlagEnabled("ui-usage")).toBe(true)
    client.isFeatureEnabled.mockReturnValue(undefined)
    expect(analytics.isFlagEnabled("ui-usage")).toBe(false)
  })

  it("a build can force flags on without a client", () => {
    const analytics = createAnalytics(null, CONTEXT, true, ["ui-cycles"])
    expect(analytics.isFlagEnabled("ui-cycles")).toBe(true)
    expect(analytics.isFlagEnabled("ui-usage")).toBe(false)
  })

  it("subscribes through the client", () => {
    const client = fakeClient()
    const unsubscribe = vi.fn()
    client.onFeatureFlags.mockReturnValue(unsubscribe)
    const analytics = createAnalytics(client, CONTEXT, true)
    const listener = vi.fn()
    analytics.subscribeFlags(listener)()
    expect(client.onFeatureFlags).toHaveBeenCalledWith(listener)
    expect(unsubscribe).toHaveBeenCalled()
  })
})
