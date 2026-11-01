import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"

import type { QuotaSnapshot } from "@mikka/protocol"

import { Daemon } from "../src/main"
import type { QuotaSource } from "../src/quota/poller"
import { connectDaemonInDataDir } from "../src/rpc/client"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, tempDir, waitFor } from "./helpers"

const SECRET = "sk-ant-api03-daemonheartbeatleak"
const CLIENT = { name: "test", version: "0" }

describe("quota on the daemon", () => {
  const daemons: Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop()
    cleanupTempDirs()
  })

  it("keeps running when a read throws and does not put the secret on the heartbeat", async () => {
    const lines: string[] = []
    const log = pino(
      { level: "info" },
      {
        write(chunk: string) {
          lines.push(String(chunk))
        },
      }
    )
    const source: QuotaSource = {
      id: "local_credentials",
      read() {
        return Promise.reject(new Error(`Bearer ${SECRET}`))
      },
    }
    const dataDir = tempDir()
    const server = new MemoryServer("device-1")
    const daemon = await new Daemon({
      dataDir,
      flavor: "dev",
      agentSandbox: null,
      link: server.link(),
      credential: "cred-1",
      harnesses: [],
      log,
      quotaSource: source,
    }).start()
    daemons.push(daemon)
    await waitFor(() =>
      lines.some((line) => line.includes("quota refresh failed"))
    )
    expect(lines.join("\n")).not.toContain(SECRET)
    expect(lines.join("\n")).toContain("[REDACTED]")

    await daemon.syncWithServer()
    const heartbeat = server.devices.get("device-1")?.lastHeartbeat
    expect(JSON.stringify(heartbeat)).not.toContain(SECRET)
    const quotas = heartbeat?.quotas ?? []
    expect(quotas).toHaveLength(3)
    expect(
      quotas.every((quota: QuotaSnapshot) => quota.status === "unknown")
    ).toBe(true)

    const client = await connectDaemonInDataDir(dataDir, CLIENT)
    const report = await client.request("quota.snapshot")
    expect(report.quotas.every((quota) => quota.status === "unknown")).toBe(
      true
    )
    expect(JSON.stringify(report)).not.toContain(SECRET)
    const status = await client.request("daemon.status")
    expect(status.pid).toBe(process.pid)
    expect(JSON.stringify(status.quotas)).not.toContain(SECRET)
    client.close()
  })
})
