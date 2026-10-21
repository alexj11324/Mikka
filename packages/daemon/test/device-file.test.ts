// device.json keeps one device id for the machine (ADR ORV-284).
import { describe, expect, it } from "vitest"

import { loadDeviceFile } from "../src/main"

describe("loadDeviceFile", () => {
  it("drops the per-workspace ids of older files and keeps the current id", () => {
    expect(
      loadDeviceFile({
        credential: "c",
        deviceId: "d-1",
        workspaceId: "w-1",
        deviceIds: { "w-1": "d-1", "w-2": "d-2" },
      })
    ).toEqual({ credential: "c", deviceId: "d-1", workspaceId: "w-1" })
  })

  it("takes a saved id when the file has no current one", () => {
    expect(loadDeviceFile({ deviceIds: { "w-2": "d-2" } })).toEqual({
      deviceId: "d-2",
    })
  })

  it("reads a missing or broken file as empty", () => {
    expect(loadDeviceFile(undefined)).toEqual({})
    expect(loadDeviceFile("nope")).toEqual({})
  })
})
