// Client for the daemon's local socket, used by the desktop's
// DaemonSupervisor and `mikka daemon status`. Handshakes on connect.
import { readFileSync } from "node:fs"
import { connect } from "node:net"

import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_ERRORS,
  daemonRpc,
  type DaemonRpcMethod,
  type DaemonRpcParams,
  type DaemonRpcResult,
  type HelloResult,
} from "@mikka/protocol"
import {
  createMessageConnection,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node"

import { daemonPaths } from "../paths"

export { ResponseError }

export interface DaemonClient {
  readonly hello: HelloResult
  request<M extends Exclude<DaemonRpcMethod, "daemon.hello">>(
    method: M,
    ...params: undefined extends DaemonRpcParams<M>
      ? [DaemonRpcParams<M>?]
      : [DaemonRpcParams<M>]
  ): Promise<DaemonRpcResult<M>>
  /** Fires when the daemon goes away (exit, restart, drain). */
  onClose(listener: () => void): void
  close(): void
}

export interface ConnectOptions {
  socketPath: string
  secret: string
  client: { name: string; version: string }
  /** Override for tests of the mismatch path. */
  protocolVersion?: number
  timeoutMs?: number
  /** On a version mismatch, ask the old daemon to drain and exit (ADR 0004). */
  drainOnMismatch?: boolean
}

export function isProtocolMismatch(
  error: unknown
): error is ResponseError<HelloResult> {
  return (
    error instanceof ResponseError &&
    error.code === DAEMON_RPC_ERRORS.protocolMismatch
  )
}

/** Socket not there or nobody listening: no daemon is running. */
export function isNoDaemon(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK"
}

export async function connectDaemon(
  options: ConnectOptions
): Promise<DaemonClient> {
  const socket = connect(options.socketPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(
        Object.assign(new Error("daemon connect timeout"), {
          code: "ETIMEDOUT",
        })
      )
    }, options.timeoutMs ?? 3_000)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  const connection: MessageConnection = createMessageConnection(
    new SocketMessageReader(socket),
    new SocketMessageWriter(socket)
  )
  connection.listen()
  try {
    const raw = await connection.sendRequest("daemon.hello", {
      protocolVersion: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION,
      secret: options.secret,
      client: options.client,
    })
    const hello = daemonRpc["daemon.hello"].result.parse(raw)
    return {
      hello,
      async request(method, ...params) {
        const result = await connection.sendRequest(method, params[0] ?? {})
        return daemonRpc[method].result.parse(result) as never
      },
      onClose(listener) {
        connection.onClose(listener)
      },
      close() {
        connection.dispose()
        socket.destroy()
      },
    }
  } catch (error) {
    if (isProtocolMismatch(error) && options.drainOnMismatch) {
      // Authenticated but incompatible: the only call left is drain.
      await Promise.race([
        connection.sendRequest("daemon.drain", {}).catch(() => undefined),
        new Promise((resolve) => {
          connection.onClose(resolve)
          setTimeout(resolve, 2_000).unref()
        }),
      ])
    }
    connection.dispose()
    socket.destroy()
    throw error
  }
}

/** Connects using the flavor data dir's socket and secret file. */
export function connectDaemonInDataDir(
  dataDir: string,
  client: ConnectOptions["client"],
  extra: Partial<ConnectOptions> = {}
): Promise<DaemonClient> {
  const paths = daemonPaths(dataDir)
  let secret: string
  try {
    secret = readFileSync(paths.secret, "utf8").trim()
  } catch (error) {
    return Promise.reject(error)
  }
  return connectDaemon({ socketPath: paths.socket, secret, client, ...extra })
}
