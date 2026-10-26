// Required Linux CI mode: real isolation startup, with no agent CLI or credentials.
import { existsSync } from "node:fs"
import { connect } from "node:net"

import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import pino from "pino"
import { expect, it } from "vitest"

import { SandboxRuntime } from "../src/agents/sandbox"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, tempDir } from "./helpers"

const HOST_DENIAL = /(?:namespace.*(?:Operation not permitted|Permission denied)|(?:uid|gid) map.*(?:Operation not permitted|Permission denied|Read-only file system)|No permissions to create new namespace)/i

function runtimeResources() {
  return {
    port: SandboxManager.getProxyPort(),
    sockets: [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()],
  }
}

async function expectStopped(resources: ReturnType<typeof runtimeResources>) {
  expect(SandboxManager.getProxyPort()).toBeUndefined()
  expect(SandboxManager.getSocksProxyPort()).toBeUndefined()
  for (const socket of resources.sockets) {
    expect(socket).toBeDefined()
    expect(existsSync(socket!)).toBe(false)
  }
  const port = resources.port
  expect(port).toBeTypeOf("number")
  const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const socket = connect({ port: port!, host: "127.0.0.1" })
    socket.once("error", resolve)
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error(`sandbox proxy still listening on ${port}`))
    })
    socket.setTimeout(2_000, () => {
      socket.destroy()
      reject(new Error(`sandbox proxy cleanup check timed out on ${port}`))
    })
  })
  expect(error.code).toBe("ECONNREFUSED")
}

it("probes real Linux isolation, advertises only usable harnesses, and cleans up on stop", async () => {
  expect(process.platform).toBe("linux")
  // Missing tools are a failure, never a skipped runtime acceptance.
  expect(SandboxManager.checkDependencies().errors).toEqual([])
  expect(SandboxRuntime.supported()).toBe(true)
  const runtime = new SandboxRuntime()
  let hostError: Error | undefined
  let daemon: Daemon | undefined
  try {
    try {
      await runtime.probe()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      hostError = error as Error
      expect(hostError.message).toMatch(/^sandbox probe failed: bwrap:/)
      expect(hostError.message).toMatch(HOST_DENIAL)
    }
    const initial = runtimeResources()
    expect(initial.port).toBeTypeOf("number")
    await runtime.reset()
    await expectStopped(initial)

    const logs: { msg: string; err?: { message: string }; resources: ReturnType<typeof runtimeResources> }[] = []
    const log = pino({ level: "warn" }, {
      write: (line) => { logs.push({ ...JSON.parse(line), resources: runtimeResources() }) },
    })
    const device = "device-sandbox-acceptance"
    const server = new MemoryServer(device)
    daemon = new Daemon({
      dataDir: tempDir(),
      flavor: "dev",
      link: server.link(),
      credential: "synthetic-test-credential",
      harnesses: [
        { harness: "mock", installed: true, version: "test" },
        { harness: "codex", installed: true, version: "test" },
      ],
      quotaSource: null,
      log,
    })
    await daemon.start()
    await daemon.syncWithServer()
    const advertised = hostError ? ["mock"] : ["mock", "codex"]
    expect(daemon.status().harnesses.map((info) => info.harness)).toEqual(advertised)
    expect(server.devices.get(device)?.info.harnesses.map((info) => info.harness)).toEqual(advertised)
    const unavailable = logs.filter((entry) => entry.msg === "agent sandbox unavailable")
    if (hostError) {
      expect(unavailable).toHaveLength(1)
      expect(unavailable[0]?.err?.message).toMatch(/^sandbox probe failed: bwrap:/)
      expect(unavailable[0]?.err?.message).toMatch(HOST_DENIAL)
      await expectStopped(unavailable[0]!.resources)
      console.log(`Sandbox acceptance: host denied isolation; daemon reported mock only: ${hostError.message}`)
    } else {
      expect(unavailable).toEqual([])
      const active = runtimeResources()
      expect(active.port).toBeTypeOf("number")
      await daemon.stop()
      await expectStopped(active)
      // A fresh owner must be able to start isolation after daemon.stop().
      await runtime.probe()
      const restarted = runtimeResources()
      expect(restarted.port).toBeTypeOf("number")
      await runtime.reset()
      await expectStopped(restarted)
      console.log("Sandbox acceptance: real probe, daemon stop, and restart passed")
    }
  } finally {
    await daemon?.stop()
    await runtime.reset()
    cleanupTempDirs()
  }
}, 60_000)
