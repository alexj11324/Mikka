// `orvilo daemon | daemon login | daemon status` (ADR 0004). The desktop app
// runs the same entry with `daemon --data-dir <userData>`.
import { parseArgs } from "node:util"

import type { Flavor } from "@orvilo/protocol"

import { readJson, writeJsonAtomic } from "./fs-util"
import { DaemonAlreadyRunningError } from "./lock"
import { createLogger } from "./log"
import { deviceLogin } from "./login"
import { startDaemon } from "./main"
import { DAEMON_VERSION, daemonPaths, defaultDataDir } from "./paths"
import { connectDaemonInDataDir, isNoDaemon } from "./rpc/client"
import { MemoryServer, type DeviceRepo, type ServerLink } from "./server-link"
import { HttpServerLink } from "./server-link-http"

const USAGE = `Usage:
  orvilo daemon [--dev] [--data-dir <dir>] [--server <url>|memory] [--mock-speed <n>] [--fixtures-dir <dir>] [--stall-minutes <n>]
  orvilo daemon login [--server <url>] [--workspace <id>] [--token <session>] [--dev] [--data-dir <dir>]
  orvilo daemon status [--dev] [--data-dir <dir>]`

const SERVER_URLS: Record<Flavor, string> = {
  prod: "https://orvilo.aspectlylabs.com",
  dev: "http://localhost:4000",
}

const CLIENT = { name: "orvilo-cli", version: DAEMON_VERSION }

export interface CliIO {
  out: (line: string) => void
  err: (line: string) => void
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/** Returns an exit code, or `null` while the daemon keeps running. */
export async function runCli(
  argv: string[],
  io: CliIO = defaultIO
): Promise<number | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dev: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      server: { type: "string" },
      "mock-speed": { type: "string" },
      "fixtures-dir": { type: "string" },
      "stall-minutes": { type: "string" },
      token: { type: "string" },
      workspace: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  const [command, sub] = positionals
  if (values.help || command !== "daemon") {
    io.out(USAGE)
    return values.help ? 0 : 2
  }
  const flavor: Flavor = values.dev ? "dev" : "prod"
  const dataDir = values["data-dir"] ?? defaultDataDir(flavor)

  if (sub === "status") {
    try {
      const client = await connectDaemonInDataDir(dataDir, CLIENT)
      io.out(JSON.stringify(await client.request("daemon.status"), null, 2))
      client.close()
      return 0
    } catch (error) {
      if (isNoDaemon(error)) {
        io.err(`No daemon running for ${dataDir}`)
        return 1
      }
      throw error
    }
  }

  if (sub === "login") {
    // Better Auth device authorization (RFC 8628), like `gh auth login`.
    // `--token` takes a session obtained elsewhere (tests, the desktop).
    let credential = values.token
    if (!credential) {
      const serverUrl =
        values.server ?? process.env.ORVILO_PUBLIC_URL ?? SERVER_URLS[flavor]
      try {
        credential = await deviceLogin({
          serverUrl,
          prompt: (code) => {
            io.out(`Your code: ${code.user_code}`)
            io.out(
              `Approve it in the Orvilo app: ${code.verification_uri_complete ?? code.verification_uri}`
            )
            io.out("Waiting for approval...")
          },
        })
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error))
        return 1
      }
    }
    const workspaceId = values.workspace
    try {
      const client = await connectDaemonInDataDir(dataDir, CLIENT)
      await client.request("device.setCredential", {
        credential,
        ...(workspaceId ? { workspaceId } : {}),
      })
      client.close()
    } catch (error) {
      if (!isNoDaemon(error)) throw error
      const file = daemonPaths(dataDir).device
      const current =
        (readJson(file) as Record<string, unknown> | undefined) ?? {}
      writeJsonAtomic(file, {
        ...current,
        credential,
        ...(workspaceId ? { workspaceId } : {}),
      })
    }
    io.out("Signed in. This device registers on the daemon's next sync.")
    return 0
  }

  if (sub !== undefined) {
    io.out(USAGE)
    return 2
  }

  const serverArg =
    values.server ?? process.env.ORVILO_PUBLIC_URL ?? SERVER_URLS[flavor]
  let link: ServerLink
  let memoryServer: MemoryServer | undefined
  let credential: string | undefined
  if (serverArg === "memory") {
    if (flavor !== "dev") {
      io.err("--server memory is only allowed with --dev")
      return 2
    }
    memoryServer = new MemoryServer("dev-device")
    const seed = readJson(daemonPaths(dataDir).devRepos) as
      | { repos?: DeviceRepo[] }
      | undefined
    for (const repo of seed?.repos ?? [])
      memoryServer.addRepo("dev-device", repo)
    link = memoryServer.link()
    credential = "dev"
  } else {
    link = new HttpServerLink(serverArg)
  }

  const log = createLogger({
    dir: daemonPaths(dataDir).logs,
    stdout: flavor === "dev",
  })
  const speed = values["mock-speed"] ? Number(values["mock-speed"]) : undefined
  try {
    const daemon = await startDaemon({
      dataDir,
      flavor,
      link,
      memoryServer,
      credential,
      log,
      mockSpeed: speed,
      fixturesDir: values["fixtures-dir"],
      stallMs: values["stall-minutes"]
        ? Number(values["stall-minutes"]) * 60_000
        : undefined,
      onDrained: () => process.exit(0),
      onLockLost: () => process.exit(1),
    })
    const shutdown = () => {
      void daemon.stop().then(() => process.exit(0))
    }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    return null
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      io.err(error.message)
      return 1
    }
    throw error
  }
}

/** Process entry for `bin/orvilo.ts` and the app-started daemon. */
export function main(argv = process.argv.slice(2)) {
  runCli(argv).then(
    (code) => {
      if (code !== null) process.exit(code)
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      )
      process.exit(1)
    }
  )
}
