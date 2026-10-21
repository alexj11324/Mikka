import { describe, expect, it } from "vitest"

import { decodeRelayClientMessage } from "./relay"
import { clientKindOf, meetsMinimumVersion } from "./version"

describe("client version gate", () => {
  it("compares semantic versions numerically", () => {
    expect(meetsMinimumVersion("0.0.1", "0.0.1")).toBe(true)
    expect(meetsMinimumVersion("0.10.0", "0.9.9")).toBe(true)
    expect(meetsMinimumVersion("0.9.9", "0.10.0")).toBe(false)
    expect(meetsMinimumVersion("1.0.0-beta.1", "1.0.0")).toBe(true)
    expect(meetsMinimumVersion(undefined, "0.0.1")).toBe(false)
    expect(meetsMinimumVersion("banana", "0.0.1")).toBe(false)
    expect(meetsMinimumVersion("1.2", "0.0.1")).toBe(false)
    expect(() => meetsMinimumVersion("1.0.0", "x")).toThrow()
  })

  it("treats anything but a named series as the desktop's", () => {
    expect(clientKindOf("mobile")).toBe("mobile")
    expect(clientKindOf("desktop")).toBe("desktop")
    // Every client older than the phone's sign-in sends nothing.
    expect(clientKindOf(undefined)).toBe("desktop")
    expect(clientKindOf(null)).toBe("desktop")
    expect(clientKindOf("watch")).toBe("desktop")
  })
})

describe("relay envelopes", () => {
  it("decodes valid frames and refuses unknown versions or junk", () => {
    const runId = "0199f000-0000-7000-8000-000000000001"
    expect(
      decodeRelayClientMessage(
        JSON.stringify({ v: 1, type: "subscribe", runId })
      )
    ).toEqual({ v: 1, type: "subscribe", runId })
    expect(
      decodeRelayClientMessage(
        JSON.stringify({ v: 2, type: "subscribe", runId })
      )
    ).toBeNull()
    expect(decodeRelayClientMessage("{")).toBeNull()
  })
})

describe("Zero update-required detection", () => {
  it("recognizes the 426 reason zero-client reports", async () => {
    const { isZeroUpdateRequired } = await import("./version")
    expect(
      isZeroUpdateRequired("Fetch from API server returned non-OK status 426")
    ).toBe(true)
    expect(
      isZeroUpdateRequired("Fetch from API server returned non-OK status 4260")
    ).toBe(false)
    expect(isZeroUpdateRequired(undefined)).toBe(false)
  })
})
