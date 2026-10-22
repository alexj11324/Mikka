// The settings contract (ORV-31 added firstDayOfWeek and commentSubmitKey).
// Everything the main process accepts from the renderer goes through
// `parseSettingsUpdate`, and a settings file written by an older version goes
// through `parseStoredSettings`, so both are worth pinning.
import { describe, expect, it } from "vitest"

import {
  DEFAULT_SETTINGS,
  parseSettingsUpdate,
  parseStoredSettings,
} from "./bridge"

describe("settings", () => {
  it("accepts the two preferences Settings › Preferences adds", () => {
    expect(parseSettingsUpdate("firstDayOfWeek", "sunday")).toEqual({
      key: "firstDayOfWeek",
      value: "sunday",
    })
    expect(parseSettingsUpdate("commentSubmitKey", "enter")).toEqual({
      key: "commentSubmitKey",
      value: "enter",
    })
  })

  it("refuses a value outside the enum and a key that is not one of ours", () => {
    expect(() => parseSettingsUpdate("firstDayOfWeek", "tuesday")).toThrow()
    expect(() =>
      parseSettingsUpdate("commentSubmitKey", "shift+enter")
    ).toThrow()
    expect(() => parseSettingsUpdate("commentSubmitKey", true)).toThrow()
    expect(() => parseSettingsUpdate("nope", "x")).toThrow()
  })

  it("defaults the new keys, so an upgrade keeps working", () => {
    expect(DEFAULT_SETTINGS.firstDayOfWeek).toBe("monday")
    expect(DEFAULT_SETTINGS.commentSubmitKey).toBe("mod+enter")
  })

  it("reads a file an older version wrote, filling the new keys in", () => {
    const stored = parseStoredSettings({ language: "en", theme: "dark" })
    expect(stored).toEqual({
      ...DEFAULT_SETTINGS,
      language: "en",
      theme: "dark",
    })
    expect(stored.firstDayOfWeek).toBe("monday")
  })

  it("keeps a stored choice for the new keys", () => {
    expect(
      parseStoredSettings({
        ...DEFAULT_SETTINGS,
        firstDayOfWeek: "sunday",
        commentSubmitKey: "enter",
      })
    ).toMatchObject({ firstDayOfWeek: "sunday", commentSubmitKey: "enter" })
  })

  it("falls back per field rather than throwing on a corrupt value", () => {
    expect(
      parseStoredSettings({ firstDayOfWeek: 7, commentSubmitKey: "enter" })
    ).toMatchObject({
      firstDayOfWeek: DEFAULT_SETTINGS.firstDayOfWeek,
      commentSubmitKey: "enter",
    })
  })
})
