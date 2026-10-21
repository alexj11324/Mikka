import { describe, expect, it } from "vitest"

import {
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_REVIEW_RULE,
  branchTemplateSchema,
  issueBranch,
  pullRequestBody,
  reviewRule,
} from "./orchestrator"

describe("issueBranch", () => {
  it("defaults to the ADR 0024 branch", () => {
    expect(issueBranch("ORV", 25)).toBe("orvilo/orv-25")
    expect(issueBranch("ORV", 25, DEFAULT_BRANCH_TEMPLATE)).toBe(
      "orvilo/orv-25"
    )
  })

  it("fills a custom template", () => {
    expect(issueBranch("ORV", 25, "issue/{number}-{team}")).toBe("issue/25-orv")
    expect(issueBranch("My Team", 7, "feat/{team}/{number}")).toBe(
      "feat/my-team/7"
    )
  })

  it("falls back to the default when a stored template is unusable", () => {
    for (const template of [
      "",
      "no-number",
      "bad branch {number}",
      "{number}..x",
    ])
      expect(issueBranch("ORV", 3, template)).toBe("orvilo/orv-3")
  })
})

describe("branchTemplateSchema", () => {
  it("requires {number}", () => {
    expect(branchTemplateSchema.safeParse("orvilo/{team}").success).toBe(false)
    expect(
      branchTemplateSchema.safeParse("orvilo/{team}-{number}").success
    ).toBe(true)
  })

  it("refuses characters git will not take", () => {
    for (const template of [
      "has space/{number}",
      "a..b/{number}",
      "a//b/{number}",
      "/lead/{number}",
      "trail/{number}/",
      "caret^/{number}",
      "at@{/{number}",
    ])
      expect(branchTemplateSchema.safeParse(template).success).toBe(false)
  })
})

describe("reviewRule", () => {
  it("defaults to the behaviour before the setting existed", () => {
    expect(reviewRule(null)).toEqual({
      requirePullRequest: true,
      requireCi: true,
      checkHarness: null,
      branchTemplate: DEFAULT_BRANCH_TEMPLATE,
      prBodyTemplate: null,
    })
    expect(reviewRule({})).toEqual(DEFAULT_REVIEW_RULE)
  })

  it("keeps stored values and falls back on an invalid row", () => {
    expect(
      reviewRule({
        requirePullRequest: false,
        requireCi: false,
        checkHarness: "cursor",
        branchTemplate: "x/{number}",
        prBodyTemplate: "body",
      })
    ).toEqual({
      requirePullRequest: false,
      requireCi: false,
      checkHarness: "cursor",
      branchTemplate: "x/{number}",
      prBodyTemplate: "body",
    })
    // An unknown harness makes the whole row unusable rather than silently
    // checking with the wrong agent.
    expect(reviewRule({ checkHarness: "gemini" })).toEqual(DEFAULT_REVIEW_RULE)
  })
})

describe("pullRequestBody", () => {
  it("keeps Orvilo's text without a template", () => {
    expect(
      pullRequestBody(null, { key: "ORV-25", title: "Review rules" })
    ).toBe("Opened by Orvilo for ORV-25. Later fix rounds push to this branch.")
    expect(
      pullRequestBody(null, {
        key: "ORV-25",
        title: "Review rules",
        summary: "Adds the table.",
      })
    ).toBe(
      "Adds the table.\n\n---\n\nOpened by Orvilo for ORV-25. Later fix rounds push to this branch."
    )
  })

  it("fills the template's placeholders", () => {
    expect(
      pullRequestBody("{key}: {title}\n\n{summary}", {
        key: "ORV-25",
        title: "Review rules",
        summary: "Adds the table.",
      })
    ).toBe("ORV-25: Review rules\n\nAdds the table.")
  })

  it("leaves no placeholder literal when a value is missing", () => {
    expect(
      pullRequestBody("{key} {summary}", { key: "ORV-25", title: "x" })
    ).toBe("ORV-25")
  })
})
