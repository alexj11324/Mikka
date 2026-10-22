import { describe, expect, it } from "vitest"

import {
  ANALYTICS_CATALOG,
  ANALYTICS_EVENTS,
  eventProperties,
  isAnalyticsEvent,
  sanitizeProperties,
} from "./analytics"
import { FEATURE_FLAGS, parseForcedFlags } from "./flags"

describe("sanitizeProperties", () => {
  it("keeps allowlisted ids, enums, numbers and booleans", () => {
    expect(
      sanitizeProperties({
        harness: "claude_code",
        outcome: "failed",
        version: "0.0.1",
        platform: "darwin",
        count: 3,
      })
    ).toEqual({
      harness: "claude_code",
      outcome: "failed",
      version: "0.0.1",
      platform: "darwin",
      count: 3,
    })
  })

  it("drops keys that are not allowlisted", () => {
    expect(
      sanitizeProperties({
        prompt: "fix my bug",
        email: "a@b.co",
        harness: "codex",
      })
    ).toEqual({ harness: "codex" })
  })

  it("drops values that look like text, paths or emails", () => {
    expect(
      sanitizeProperties({
        harness: "fix the login bug",
        outcome: "/Users/alex/secret.ts",
        provider: "alex@example.com",
        language: "x".repeat(41),
      })
    ).toEqual({})
  })

  it("accepts no properties", () => {
    expect(sanitizeProperties(undefined)).toEqual({})
  })
})

describe("the catalog", () => {
  it("names events object_action in snake_case", () => {
    for (const name of ANALYTICS_EVENTS)
      expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/)
  })

  it("accepts only the declared names", () => {
    for (const name of ANALYTICS_EVENTS)
      expect(isAnalyticsEvent(name)).toBe(true)
    expect(isAnalyticsEvent("clicked_button")).toBe(false)
    expect(isAnalyticsEvent("toString")).toBe(false)
    expect(isAnalyticsEvent(undefined)).toBe(false)
  })

  it("lists no property twice per event", () => {
    for (const keys of Object.values(ANALYTICS_CATALOG))
      expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("eventProperties", () => {
  const context = { flavor: "prod", version: "0.0.1", runtime: "electron" }

  it("adds the context and the properties the event lists", () => {
    expect(
      eventProperties("run_finished", context, {
        harness: "codex",
        outcome: "completed",
      })
    ).toEqual({ ...context, harness: "codex", outcome: "completed" })
  })

  it("drops a known key the event does not list", () => {
    expect(
      eventProperties("comment_edited", context, { harness: "codex" })
    ).toEqual(context)
  })

  it("does not let a caller override the context", () => {
    expect(
      eventProperties("app_opened", context, {
        version: "9.9.9",
        language: "en",
      })
    ).toEqual({ ...context, language: "en" })
  })
})

describe("feature flags", () => {
  it("parses the forced list", () => {
    expect(parseForcedFlags(undefined)).toEqual([])
    expect(parseForcedFlags("ui-usage, nope ,ui-cycles")).toEqual([
      "ui-usage",
      "ui-cycles",
    ])
    expect(parseForcedFlags("all")).toEqual([...FEATURE_FLAGS])
  })

  it("names flags ui-<area> or feat-<name>", () => {
    for (const flag of FEATURE_FLAGS)
      expect(flag).toMatch(/^(ui|feat)(-[a-z]+)+$/)
  })

  it("lists each flag once", () => {
    expect(new Set(FEATURE_FLAGS).size).toBe(FEATURE_FLAGS.length)
  })
})
