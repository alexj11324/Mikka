import { describe, expect, it } from "vitest"

import { classifySandboxFailure, readUsernsRestriction, sanitizeSandboxDetail } from "../src/sandbox-issue"

describe("why the run sandbox could not start", () => {
  // The exact line GitHub's ubuntu-24.04 runner printed (CI run 41313960870),
  // with kernel.apparmor_restrict_unprivileged_userns = 1.
  const ci = "sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"

  it("names Ubuntu's AppArmor user namespace restriction from bwrap's own error", () => {
    expect(classifySandboxFailure(new Error(ci), false, "/home/alex")).toEqual({
      reason: "userns_restricted",
      detail: ci,
    })
    expect(classifySandboxFailure(new Error("sandbox probe failed: bwrap: setting up uid map: Permission denied"), false, "/home/alex").reason)
      .toBe("userns_restricted")
  })

  it("names it from a permission error when the sysctl reads 1", () => {
    expect(classifySandboxFailure(new Error("sandbox probe failed: bwrap: Can't mount proc on /newroot/proc: Operation not permitted"), true, "/home/alex").reason)
      .toBe("userns_restricted")
  })

  it("keeps other failures generic, with their own error", () => {
    expect(classifySandboxFailure(new Error("sandbox probe failed: timed out"), true, "/home/alex")).toEqual({ detail: "sandbox probe failed: timed out" })
    expect(classifySandboxFailure(new Error("Run sandbox isolation unavailable: bubblewrap 0.4.0 is older than 0.5.0"), false, "/home/alex"))
      .toEqual({ detail: "Run sandbox isolation unavailable: bubblewrap 0.4.0 is older than 0.5.0" })
    expect(classifySandboxFailure(undefined, false, "/home/alex")).toEqual({})
  })

  it("shows no home directory, no variable values, and stays short", () => {
    expect(sanitizeSandboxDetail("bwrap: execvp /home/alex/.mikka/sandbox-tools/libexec/bwrap: No such file", "/home/alex"))
      .toBe("bwrap: execvp ~/.mikka/sandbox-tools/libexec/bwrap: No such file")
    expect(sanitizeSandboxDetail("failed with ANTHROPIC_API_KEY=sk-secret HOME='/home/alex' x", "/home/alex"))
      .toBe("failed with ANTHROPIC_API_KEY=… HOME=… x")
    const long = sanitizeSandboxDetail("x".repeat(1000), "/home/alex")
    expect(long.length).toBe(300)
    expect(long.endsWith("…")).toBe(true)
    expect(sanitizeSandboxDetail("a\nb\u0000c", "/home/alex")).toBe("a b c")
  })

  it("reads the sysctl, and treats a missing one as unrestricted", () => {
    expect(readUsernsRestriction(() => "1\n")).toBe(true)
    expect(readUsernsRestriction(() => "0\n")).toBe(false)
    expect(readUsernsRestriction(() => { throw new Error("ENOENT") })).toBe(false)
  })
})
