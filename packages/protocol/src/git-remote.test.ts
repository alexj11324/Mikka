import { describe, expect, it } from "vitest"

import {
  normalizeRepoKey,
  parseGitRemote,
  redactRemoteUrl,
  repoIdentity,
} from "./git-remote"

describe("parseGitRemote", () => {
  it("reads https, ssh and scp-like GitHub remotes", () => {
    const want = {
      host: "github.com",
      owner: "alexj11324",
      name: "Mikka",
      webUrl: "https://github.com/alexj11324/Mikka",
      isGitHub: true,
    }
    for (const url of [
      "https://github.com/alexj11324/Mikka.git",
      "https://github.com/alexj11324/Mikka",
      "git@github.com:alexj11324/Mikka.git",
      "ssh://git@github.com/alexj11324/Mikka.git",
      "ssh://git@github.com:22/alexj11324/Mikka.git",
      "https://x-access-token:abc@github.com/alexj11324/Mikka.git/",
    ])
      expect(parseGitRemote(url)).toEqual(want)
  })

  it("keeps group paths on other hosts", () => {
    expect(parseGitRemote("git@gitlab.com:team/sub/app.git")).toMatchObject({
      host: "gitlab.com",
      owner: "team/sub",
      name: "app",
      isGitHub: false,
    })
  })

  it("is null for local paths and ownerless remotes", () => {
    for (const url of [
      "/Users/a/repo",
      "C:\\code\\repo",
      "file:///tmp/r",
      "",
      null,
      "https://github.com/solo",
    ])
      expect(parseGitRemote(url)).toBeNull()
  })
})

describe("redactRemoteUrl", () => {
  it("drops credentials but keeps the ssh user", () => {
    expect(redactRemoteUrl("https://u:tok@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
    expect(redactRemoteUrl("https://tok@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
    expect(redactRemoteUrl("ssh://git@github.com/o/r.git")).toBe(
      "ssh://git@github.com/o/r.git"
    )
    expect(redactRemoteUrl("git@github.com:o/r.git")).toBe(
      "git@github.com:o/r.git"
    )
  })

  it("reads the userinfo the way git does, up to the last @ in the authority", () => {
    // The userinfo runs to the LAST `@`; stopping at the first one leaves the
    // token behind, because the host then reads as `user:token@host`.
    expect(redactRemoteUrl("https://@u:tok@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
    expect(redactRemoteUrl("https://u@tok@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
    expect(redactRemoteUrl("https://u:p@x@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
  })

  it("keeps the port, the path, the query and the fragment", () => {
    expect(redactRemoteUrl("https://u:tok@github.com:8443/o/r.git")).toBe(
      "https://github.com:8443/o/r.git"
    )
    expect(redactRemoteUrl("https://u:tok@github.com/o/r.git?x=1")).toBe(
      "https://github.com/o/r.git?x=1"
    )
    expect(redactRemoteUrl("https://u:tok@github.com/o/r.git#frag")).toBe(
      "https://github.com/o/r.git#frag"
    )
  })

  it("leaves a URL with no credentials exactly as it is", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "http://localhost:3000/o/r.git",
      "ssh://git@github.com/o/r.git",
      "git@github.com:o/r.git",
      "/Users/me/code/r",
    ]) {
      expect(redactRemoteUrl(url)).toBe(url)
    }
  })

  it("still strips a credential that contains a ? or a #", () => {
    // The run must not stop at `?`/`#`: a credential holding one of them would
    // then match nothing, and an unmatched URL is returned unchanged.
    expect(redactRemoteUrl("https://me:hunter2#1@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
    expect(redactRemoteUrl("https://me:tok?en@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git"
    )
  })

  it("fails closed: no URL with an @ before the path keeps its userinfo", () => {
    // Whatever the shape, a secret must not survive. This is the property the
    // pattern has to hold, so it is asserted rather than left to the cases.
    const secrets = [
      "https://@u:tok@github.com/o/r.git",
      "https://u:tok@github.com/o/r.git",
      "https://me:hunter2#1@github.com/o/r.git",
      "https://me:tok?en@github.com/o/r.git",
      "ssh://git:tok@github.com/o/r.git",
      "https://u:tok@github.com:8443/o/r.git?x=1#f",
    ]
    for (const url of secrets) {
      const redacted = redactRemoteUrl(url)
      expect(redacted).not.toContain("tok")
      expect(redacted).not.toContain("hunter2")
    }
  })

  it("still strips an ssh password while keeping the user", () => {
    expect(redactRemoteUrl("ssh://git:tok@github.com/o/r.git")).toBe(
      "ssh://github.com/o/r.git"
    )
  })
})

describe("repoIdentity", () => {
  it("is one key for every URL form of the same repo", () => {
    for (const url of [
      "https://github.com/alexj11324/Mikka.git",
      "git@github.com:alexj11324/Mikka.git",
      "ssh://git@github.com/alexj11324/Mikka.git",
      "https://x-access-token:abc@github.com/alexj11324/Mikka.git",
      "https://GitHub.com/AlexJ11324/Mikka",
    ])
      expect(repoIdentity(url)).toBe("github.com/alexj11324/mikka")
  })

  it("keeps a group path and is null when no repo is named", () => {
    expect(repoIdentity("git@gitlab.com:team/sub/app.git")).toBe(
      "gitlab.com/team/sub/app"
    )
    for (const url of ["/Users/a/repo", "", null, "https://github.com/solo"])
      expect(repoIdentity(url)).toBeNull()
  })
})

describe("normalizeRepoKey", () => {
  it("accepts a URL or an identity and returns the identity", () => {
    expect(normalizeRepoKey("git@github.com:Acme/App.git")).toBe(
      "github.com/acme/app"
    )
    expect(normalizeRepoKey("github.com/Acme/App")).toBe("github.com/acme/app")
    expect(normalizeRepoKey(" /github.com/acme/app/ ")).toBe(
      "github.com/acme/app"
    )
  })

  it("refuses anything that names no repository", () => {
    for (const value of ["", "  ", null, "acme/app", "/tmp/repo", "a/b/c/d"])
      expect(normalizeRepoKey(value)).toBeNull()
  })
})
