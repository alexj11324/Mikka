import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SandboxRuntime } from "../src/agents/sandbox"

afterEach(() => vi.restoreAllMocks())

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

describe("sandbox runtime ownership", () => {
  it("does not wrap commands while a reset is in progress", async () => {
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue()
    let finishReset!: () => void
    const reset = vi.spyOn(SandboxManager, "reset").mockImplementation(
      () => new Promise<void>((resolve) => { finishReset = resolve })
    )
    vi.spyOn(SandboxManager, "wrapWithSandbox").mockResolvedValue(":")
    vi.spyOn(SandboxManager, "registerCommandNetworkLists").mockImplementation(() => {})
    vi.spyOn(SandboxManager, "unregisterCommandNetworkLists").mockImplementation(() => {})
    const sandbox = new SandboxRuntime()
    const policy = { allowWrite: [], allowDomains: [] }
    ;(await sandbox.wrap([":"], policy)).release()
    const stopping = sandbox.reset()
    await expect(sandbox.wrap([":"], policy)).rejects.toThrow("stopping")
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
    finishReset()
    await stopping
  })

  it("cleans up a failed initialization so another instance can start", async () => {
    const initialize = vi.spyOn(SandboxManager, "initialize")
      .mockRejectedValueOnce(new Error("proxy failed"))
      .mockResolvedValue()
    const reset = vi.spyOn(SandboxManager, "reset").mockResolvedValue()
    vi.spyOn(SandboxManager, "wrapWithSandbox").mockResolvedValue(":")
    vi.spyOn(SandboxManager, "registerCommandNetworkLists").mockImplementation(() => {})
    vi.spyOn(SandboxManager, "unregisterCommandNetworkLists").mockImplementation(() => {})
    const first = new SandboxRuntime()
    const second = new SandboxRuntime()
    const policy = { allowWrite: [], allowDomains: [] }
    try {
      await expect(first.wrap([":"], policy)).rejects.toThrow("proxy failed")
      expect(reset).toHaveBeenCalledOnce()
      ;(await second.wrap([":"], policy)).release()
      expect(initialize).toHaveBeenCalledTimes(2)
    } finally {
      await first.reset()
      await second.reset()
    }
  })

  it("prevents another instance from resetting an active runtime and permits reuse after reset", async () => {
    const initialize = vi.spyOn(SandboxManager, "initialize").mockResolvedValue()
    const reset = vi.spyOn(SandboxManager, "reset").mockResolvedValue()
    vi.spyOn(SandboxManager, "wrapWithSandbox").mockResolvedValue(":")
    vi.spyOn(SandboxManager, "registerCommandNetworkLists").mockImplementation(() => {})
    vi.spyOn(SandboxManager, "unregisterCommandNetworkLists").mockImplementation(() => {})
    const first = new SandboxRuntime()
    const second = new SandboxRuntime()
    const policy = { allowWrite: [], allowDomains: [] }
    try {
      ;(await first.wrap([":"], policy)).release()
      await expect(second.wrap([":"], policy)).rejects.toThrow("already in use")
      await second.reset()
      expect(reset).not.toHaveBeenCalled()
      await first.reset()
      expect(reset).toHaveBeenCalledOnce()
      ;(await second.wrap([":"], policy)).release()
      expect(initialize).toHaveBeenCalledTimes(2)
    } finally {
      await first.reset()
      await second.reset()
    }
  })
})
