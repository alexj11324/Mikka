import { describe, expect, it, vi } from "vitest"

import { SandboxRuntime } from "../src/agents/sandbox"

describe("sandbox startup probe", () => {
  it("reports a failed sandbox command and releases its registration", async () => {
    const sandbox = new SandboxRuntime()
    const release = vi.fn()
    vi.spyOn(sandbox, "wrap").mockResolvedValue({
      command: "echo 'bwrap: uid map failed' >&2; exit 1",
      annotate: (stderr) => stderr,
      release,
    })
    await expect(sandbox.probe()).rejects.toThrow("bwrap: uid map failed")
    expect(release).toHaveBeenCalledOnce()
  })

  it("accepts a successful sandbox command and releases its registration", async () => {
    const sandbox = new SandboxRuntime()
    const release = vi.fn()
    vi.spyOn(sandbox, "wrap").mockResolvedValue({
      command: ":",
      annotate: (stderr) => stderr,
      release,
    })
    await expect(sandbox.probe()).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })
})
