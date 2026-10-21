import { describe, expect, it } from "vitest"

import { PREVIEW_CSP_HEADER, previewHtml, withPreviewCsp } from "./preview"

describe("preview", () => {
  it("puts the CSP after the doctype so the page stays in standards mode", () => {
    const page = withPreviewCsp("<!DOCTYPE html><html><body>hi</body></html>")
    expect(page.startsWith("<!DOCTYPE html><meta http-equiv=")).toBe(true)
    expect(page.endsWith("<html><body>hi</body></html>")).toBe(true)
  })

  it("puts the CSP first when there is no doctype", () => {
    expect(withPreviewCsp("<p>hi</p>")).toMatch(
      /^<meta http-equiv=.*<p>hi<\/p>$/
    )
  })

  it("allows no network and sandboxes the page", () => {
    expect(PREVIEW_CSP_HEADER).toMatch(/^sandbox allow-scripts; /)
    expect(PREVIEW_CSP_HEADER).toContain("default-src 'none'")
    expect(PREVIEW_CSP_HEADER).not.toMatch(/allow-same-origin|https?:|\*/)
  })

  it("rejects pages over the size limit", () => {
    expect(previewHtml.safeParse("x".repeat(6 * 1024 * 1024)).success).toBe(
      false
    )
  })
})
