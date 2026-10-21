import { describe, expect, it } from "vitest"

import {
  ISSUE_SHARE_PERMISSIONS,
  createShareToken,
  hashShareToken,
  isShareToken,
  isShareTokenHash,
  issueShareUrl,
  stripMentions,
} from "./issue-share"

describe("share tokens", () => {
  it("mints 43 base64url characters, a fresh one every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createShareToken()))
    expect(tokens.size).toBe(50)
    for (const token of tokens) {
      expect(token).toHaveLength(43)
      expect(isShareToken(token)).toBe(true)
    }
  })

  it("refuses anything that is not one of ours", () => {
    expect(isShareToken("")).toBe(false)
    expect(isShareToken("short")).toBe(false)
    expect(isShareToken("a".repeat(42))).toBe(false)
    expect(isShareToken("a".repeat(44))).toBe(false)
    // Padding and the standard-alphabet characters never appear.
    expect(isShareToken(`${"a".repeat(42)}=`)).toBe(false)
    expect(isShareToken(`${"a".repeat(42)}+`)).toBe(false)
    expect(isShareToken(`${"a".repeat(42)}/`)).toBe(false)
  })

  it("hashes to lowercase hex sha256, the same value every time", async () => {
    const token = createShareToken()
    const hash = await hashShareToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(isShareTokenHash(hash)).toBe(true)
    expect(await hashShareToken(token)).toBe(hash)
    expect(await hashShareToken(createShareToken())).not.toBe(hash)
    expect(isShareTokenHash(hash.toUpperCase())).toBe(false)
  })
})

describe("share links", () => {
  it("puts the token under the share path", () => {
    expect(issueShareUrl("https://orvilo.example", "tok")).toBe(
      "https://orvilo.example/share/tok"
    )
  })

  it("does not double the slash when the base ends with one", () => {
    expect(issueShareUrl("https://orvilo.example/", "tok")).toBe(
      "https://orvilo.example/share/tok"
    )
    expect(issueShareUrl("https://orvilo.example///", "tok")).toBe(
      "https://orvilo.example/share/tok"
    )
  })
})

describe("mentions from outside", () => {
  it("flattens the chip syntax to plain text", () => {
    expect(
      stripMentions(
        "ping @[Alex Jiang](user:3f2504e0-4f89-11d3-9a0c-0305e82c3301) now"
      )
    ).toBe("ping @Alex Jiang now")
  })

  it("flattens every mention, and leaves other text alone", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    expect(stripMentions(`@[A](user:${uuid}) and @[B](user:${uuid})`)).toBe(
      "@A and @B"
    )
    expect(stripMentions("plain @text, no chip")).toBe("plain @text, no chip")
  })

  it("does not treat a mention of an agent, or a malformed one, as a chip", () => {
    // Only `user:` is a chip in this app, so only that syntax is flattened.
    expect(stripMentions("@[Bot](agent:not-a-uuid)")).toBe(
      "@[Bot](agent:not-a-uuid)"
    )
    expect(stripMentions("@[Name](user:too-short)")).toBe(
      "@[Name](user:too-short)"
    )
  })
})

describe("share permissions", () => {
  it("is read or comment, in that order", () => {
    expect([...ISSUE_SHARE_PERMISSIONS]).toEqual(["read", "comment"])
  })
})
