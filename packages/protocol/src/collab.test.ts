import { describe, expect, it } from "vitest"

import { COLLAB_COLORS, collabColorFor } from "./collab"

describe("a member's cursor colour", () => {
  it("is stable for the same member", () => {
    const id = "9f1f0a3e-6a1c-4c1c-9a9e-2b8b6f4d1e21"
    expect(collabColorFor(id)).toBe(collabColorFor(id))
  })

  it("is always one of the palette", () => {
    for (let i = 0; i < 200; i++) {
      const id = `user-${i}`
      expect(COLLAB_COLORS).toContain(collabColorFor(id))
    }
  })

  it("spreads members across the palette", () => {
    const used = new Set(
      Array.from({ length: 200 }, (_, i) => collabColorFor(`member-${i}`))
    )
    expect(used.size).toBe(COLLAB_COLORS.length)
  })
})
