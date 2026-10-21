// Local control channel: JSON-RPC 2.0 (vscode-jsonrpc framing) over a Unix
// socket in the flavor's data dir, mode 0600. A connection must first call
// `daemon.hello` with the matching protocol version and the daemon secret;
// anything else is refused (ADR 0004).
import { timingSafeEqual } from "node:crypto"
import { chmodSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"

import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_ERRORS,
  daemonRpc,
  type DaemonRpcMethod,
  type DaemonRpcResult,
  type HelloResult,
} from "@orvilo/protocol"
import {
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
} from "vscode-jsonrpc/node"

import { DaemonError } from "../errors"
import type { Logger } from "../log"

export type RpcHandlers = {
  [M in Exclude<DaemonRpcMethod, "daemon.hello">]: (
    params: NonNullable<unknown>
  ) => Promise<DaemonRpcResult<M>> | DaemonRpcResult<M>
}

export interface RpcServerOptions {
  socketPath: string
  secret: string
  hello: () => HelloResult
  handlers: RpcHandlers
  log: Logger
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function toResponseError(error: unknown, log: Logger): ResponseError<unknown> {
  if (error instanceof ResponseError) return error
  if (error instanceof DaemonError) {
    return new ResponseError(error.code, error.message, error.data)
  }
  if (error && typeof error === "object" && "issues" in error) {
    return new ResponseError(
      ErrorCodes.InvalidParams,
      "Invalid params",
      (error as { issues: unknown }).issues
    )
  }
  log.error({ err: error }, "rpc handler failed")
  return new ResponseError(
    ErrorCodes.InternalError,
    error instanceof Error ? error.message : "Internal error"
  )
}

export class RpcServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()

  constructor(private readonly options: RpcServerOptions) {}

  async listen() {
    const { socketPath } = this.options
    // We hold the data-dir lock, so a socket file here is stale.
    rmSync(socketPath, { force: true })
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })
    chmodSync(socketPath, 0o600)
    this.server = server
  }

  private accept(socket: Socket) {
    this.sockets.add(socket)
    socket.on("close", () => this.sockets.delete(socket))
    const { log, handlers } = this.options
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket)
    )
    // "none" -> "authenticated" (secret ok, version mismatch: may only drain)
    // -> "handshaken" (secret and version ok: every method).
    let stage: "none" | "authenticated" | "handshaken" = "none"

    connection.onRequest(async (method: string, raw: unknown) => {
      try {
        if (!Object.hasOwn(daemonRpc, method)) {
          throw new ResponseError(
            ErrorCodes.MethodNotFound,
            `Unknown method ${method}`
          )
        }
        const name = method as DaemonRpcMethod
        if (name === "daemon.hello") {
          const hello = daemonRpc["daemon.hello"].params.parse(raw)
          const own = this.options.hello()
          if (!sameSecret(hello.secret, this.options.secret)) {
            throw new ResponseError(
              DAEMON_RPC_ERRORS.unauthorized,
              "Bad daemon secret"
            )
          }
          stage = "authenticated"
          if (hello.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
            throw new ResponseError(
              DAEMON_RPC_ERRORS.protocolMismatch,
              `Protocol mismatch: daemon speaks ${DAEMON_PROTOCOL_VERSION}, client ${hello.protocolVersion}`,
              own
            )
          }
          stage = "handshaken"
          return own
        }
        // A newer app asks an older daemon to step aside (ADR 0004); `daemon.drain`
        // is the one method every protocol version keeps.
        const allowed =
          stage === "handshaken" ||
          (stage === "authenticated" && name === "daemon.drain")
        if (!allowed) {
          throw new ResponseError(
            DAEMON_RPC_ERRORS.handshakeRequired,
            "Call daemon.hello first"
          )
        }
        const params = daemonRpc[name].params.parse(raw ?? {}) ?? {}
        return await handlers[name](params)
      } catch (error) {
        return toResponseError(error, log)
      }
    })
    connection.onError(([error]) =>
      log.debug({ err: error }, "rpc connection error")
    )
    connection.onClose(() => connection.dispose())
    connection.listen()
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    this.server = null
    rmSync(this.options.socketPath, { force: true })
  }
}
