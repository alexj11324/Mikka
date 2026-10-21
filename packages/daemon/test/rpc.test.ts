import { DAEMON_PROTOCOL_VERSION, DAEMON_RPC_ERRORS } from "@mikka/protocol"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Daemon } from "../src/main"
import { DaemonAlreadyRunningError } from "../src/lock"
import {
  connectDaemon,
  connectDaemonInDataDir,
  isProtocolMismatch,
} from "../src/rpc/client"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, tempDir } from "./helpers"

const CLIENT = { name: "test", version: "0" }

describe("local RPC handshake", () => {
  let daemon: Daemon
  let dataDir: string

  beforeEach(async () => {
    dataDir = tempDir()
    daemon = await new Daemon({
      dataDir,
      flavor: "dev",
      link: new MemoryServer().link(),
      harnesses: [],
      quotaSource: null,
    }).start()
  })

  afterEach(async () => {
    await daemon.stop()
    cleanupTempDirs()
  })

  it("accepts a matching version and secret", async () => {
    const client = await connectDaemonInDataDir(dataDir, CLIENT)
    expect(client.hello.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION)
    const status = await client.request("daemon.status")
    expect(status.server).toBe("unregistered")
    expect(status.dataDir).toBe(dataDir)
    client.close()
  })

  it("refuses a protocol version mismatch", async () => {
    const error = await connectDaemonInDataDir(dataDir, CLIENT, {
      protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
    }).catch((e: unknown) => e)
    expect(isProtocolMismatch(error)).toBe(true)
  })

  it("lets a newer client drain a mismatched daemon", async () => {
    const drained = new Promise<void>((resolve) => {
      ;(
        daemon as unknown as { options: { onDrained: () => void } }
      ).options.onDrained = resolve
    })
    const error = await connectDaemonInDataDir(dataDir, CLIENT, {
      protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      drainOnMismatch: true,
    }).catch((e: unknown) => e)
    expect(isProtocolMismatch(error)).toBe(true)
    await drained
    await expect(connectDaemonInDataDir(dataDir, CLIENT)).rejects.toMatchObject(
      {
        code: "ENOENT",
      }
    )
  })

  it("keeps one device id across workspaces and forgets the credential on sign-out", async () => {
    const ws1 = "0199f000-0000-7000-8000-000000000001"
    const ws2 = "0199f000-0000-7000-8000-000000000002"
    const client = await connectDaemonInDataDir(dataDir, CLIENT)
    await client.request("device.setCredential", {
      credential: "cred-a",
      workspaceId: ws1,
    })
    await daemon.syncWithServer()
    const first = await client.request("daemon.status")
    expect(first).toMatchObject({
      workspaceId: ws1,
      signedIn: true,
      server: "online",
    })
    // The same person in another workspace.
    await client.request("device.setCredential", {
      credential: "cred-a",
      workspaceId: ws2,
    })
    await daemon.syncWithServer()
    const second = await client.request("daemon.status")
    expect(second.workspaceId).toBe(ws2)
    // One machine, one device id in every workspace (ADR ORV-284).
    expect(second.deviceId).toBe(first.deviceId)
    // Back to the first workspace: still the same device.
    await client.request("device.setCredential", {
      credential: "cred-a",
      workspaceId: ws1,
    })
    await daemon.syncWithServer()
    expect((await client.request("daemon.status")).deviceId).toBe(
      first.deviceId
    )
    await client.request("device.clearCredential")
    await daemon.syncWithServer()
    expect(await client.request("daemon.status")).toMatchObject({
      signedIn: false,
      server: "unregistered",
      deviceId: first.deviceId,
    })
    client.close()
  })

  it("refuses a wrong secret", async () => {
    const error = await connectDaemon({
      socketPath: daemon.paths.socket,
      secret: "wrong",
      client: CLIENT,
    }).catch((e: unknown) => e)
    expect((error as { code: number }).code).toBe(
      DAEMON_RPC_ERRORS.unauthorized
    )
  })

  it("allows one daemon per data dir", async () => {
    const second = new Daemon({
      dataDir,
      flavor: "dev",
      link: new MemoryServer().link(),
      harnesses: [],
      quotaSource: null,
    })
    await expect(second.start()).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError
    )
  }, 30_000)
})
