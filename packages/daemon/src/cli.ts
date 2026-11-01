// `mikka daemon | daemon login | daemon status` (ADR 0004). The desktop app
// runs the same entry with `daemon --data-dir <userData>`.
import { parseArgs } from "node:util"
import { watch } from 'node:fs'

import type { Flavor } from "@mikka/protocol"

import { readJson, writeJsonAtomic } from "./fs-util"
import { DaemonAlreadyRunningError, daemonProcessAlive, LOCK_TAKEOVER_MS } from "./lock"
import { createLogger } from "./log"
import { managedAutoUpdateRuntime } from "./auto-update"
import { installService } from "./service"
import { deviceLogin, registrationLogin } from "./login"
import { startDaemon } from "./main"
import { DAEMON_VERSION, daemonPaths, defaultDataDir } from "./paths"
import { connectDaemonInDataDir, isNoDaemon, type DaemonClient } from "./rpc/client"
import { MemoryServer, type DeviceRepo, type ServerLink } from "./server-link"
import { HttpServerLink } from "./server-link-http"

const USAGE = `Usage:
  mikka daemon [--dev] [--no-auto-update] [--data-dir <dir>] [--server <url>|memory] [--mock-speed <n>] [--fixtures-dir <dir>] [--stall-minutes <n>] [--hosted-subscriptions]
  mikka daemon login [--server <url>] [--workspace <id>] [--token <device-token>] [--dev] [--data-dir <dir>]
  mikka daemon status [--dev] [--data-dir <dir>]`

const SERVER_URLS: Record<Flavor, string> = {
  prod: "https://app.aspectlylabs.com/mikka",
  dev: "http://localhost:4000",
}

const CLIENT = { name: "mikka-cli", version: DAEMON_VERSION }

/** A service may hold its lock/read device.json before opening its RPC socket.
 * A login persisted in that window must reach the live process as well. Watch
 * readiness rather than sleeping, and retain the daemon's existing startup bound. */
async function connectStartingDaemon(dataDir: string): Promise<DaemonClient | undefined> {
  if (!daemonProcessAlive(dataDir)) return undefined
  let revision = 0, timedOut = false, failure: Error | undefined
  let wake: (() => void) | undefined
  const changed = () => { revision++; wake?.() }
  const watcher = watch(dataDir, changed)
  watcher.on('error', error => { failure = error; changed() })
  const timer = setTimeout(() => { timedOut = true; changed() }, LOCK_TAKEOVER_MS)
  try {
    for (;;) {
      if (failure) throw failure
      if (timedOut) throw new Error(`The daemon is starting but its control socket did not become ready within ${LOCK_TAKEOVER_MS / 1000} seconds. Retry sign-in when the service is ready.`)
      const before = revision
      try { return await connectDaemonInDataDir(dataDir, CLIENT) }
      catch (error) { if (!isNoDaemon(error)) throw error }
      // If the holder exited, the saved credential belongs to its next start.
      if (!daemonProcessAlive(dataDir)) return undefined
      if (revision !== before) continue
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
  } finally { clearTimeout(timer); watcher.close() }
}

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
  io: CliIO = defaultIO,
  privateConfig?: { protectionBypass?: string }
): Promise<number | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dev: { type: "boolean", default: false },
      "no-auto-update": { type: "boolean", default: false },
      "data-dir": { type: "string" },
      server: { type: "string" },
      "mock-speed": { type: "string" },
      "fixtures-dir": { type: "string" },
      "retain-resources": { type: "boolean", default: false },
      "stall-minutes": { type: "string" },
      "hosted-subscriptions": { type: "boolean", default: false },
      "e2b-container-runtime": { type: "boolean", default: false },
      "e2b-computer": { type: "boolean", default: false },
      token: { type: "string" },
      "registration-token-stdin": { type: "boolean" },
      "device-type": { type: "string" },
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

  if (sub === 'service' && positionals[2] === 'install') {
    await installService(values.server ?? SERVER_URLS[flavor], values['device-type'], { dataDir, dev: values.dev, autoUpdate: !values['no-auto-update'] })
    io.out('Service installed.')
    return 0
  }

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
    // `--token` takes an existing device token (manual setup or tests).
    let credential = values.token
    if (values["registration-token-stdin"]) {
      let input = ''
      for await (const chunk of process.stdin) {
        input += chunk
        if (input.length > 256) throw new Error('Invalid registration token')
      }
      credential = await registrationLogin({ serverUrl: values.server ?? SERVER_URLS[flavor], token: input.trim() })
    }
    if (!credential) {
      const serverUrl =
        values.server ?? process.env.MIKKA_PUBLIC_URL ?? SERVER_URLS[flavor]
      try {
        credential = await deviceLogin({
          serverUrl,
          prompt: (code) => {
            io.out(`Your code: ${code.user_code}`)
            io.out(
              `Approve it in your browser: ${code.verification_uri_complete ?? code.verification_uri}`
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
      // Persist before checking the PID. If a process already read the old
      // file, its PID necessarily exists and it must receive the credential
      // over RPC. A process starting later reads the newly persisted file.
      const starting = await connectStartingDaemon(dataDir)
      if (starting) {
        try {
          await starting.request('device.setCredential', { credential, ...(workspaceId ? { workspaceId } : {}) })
        } finally { starting.close() }
      }
    }
    io.out("Signed in. This device registers on the daemon's next sync.")
    return 0
  }

  if (sub !== undefined) {
    io.out(USAGE)
    return 2
  }

  const serverArg =
    values.server ?? process.env.MIKKA_PUBLIC_URL ?? SERVER_URLS[flavor]
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
      { repos?: DeviceRepo[] } | undefined
    for (const repo of seed?.repos ?? [])
      memoryServer.addRepo("dev-device", repo)
    link = memoryServer.link()
    credential = "dev"
  } else {
    link = new HttpServerLink(serverArg, fetch, DAEMON_VERSION, privateConfig?.protectionBypass)
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
      autoUpdate: await managedAutoUpdateRuntime(process.argv[1] ?? "", flavor, !values["no-auto-update"] && !values["hosted-subscriptions"] && !values["e2b-container-runtime"] && !values["e2b-computer"]),
      link,
      memoryServer,
      credential,
      log,
      mockSpeed: speed,
      fixturesDir: values["fixtures-dir"],
      retainResources: values["retain-resources"],
      hostedSubscriptions: values["hosted-subscriptions"],
      e2bContainerRuntime: values["e2b-container-runtime"],
      cloudComputer: values["e2b-computer"],
      stallMs: values["stall-minutes"]
        ? Number(values["stall-minutes"]) * 60_000
        : undefined,
      onDrained: () => process.exit(0),
      onLockLost: () => process.exit(1),
    })
    const shutdown = () => {
      void daemon.stop().then(() => process.exit(0))
    }
    process.once('SIGUSR2', () => { void daemon.stop().then(() => process.exit(1)) })
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

/** Process entry for `bin/mikka.ts` and the app-started daemon. */
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
