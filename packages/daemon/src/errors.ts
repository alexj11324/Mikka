import { DAEMON_RPC_ERRORS } from "@mikka/protocol"

/**
 * An error the daemon reports to RPC callers with a stable code. Anything
 * else thrown inside a handler becomes `internal` and is only logged.
 */
export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = "DaemonError"
  }
}

export class InvalidRepositoryError extends DaemonError {
  constructor(message = 'Invalid repository URL; dispatch a new thread.') {
    super(
      DAEMON_RPC_ERRORS.repoNotAllowed,
      message,
    )
  }
}

export class RunNotFoundError extends DaemonError {
  constructor(runId: string) {
    super(DAEMON_RPC_ERRORS.runNotFound, `Run "${runId}" not found`, { runId })
  }
}

/** The server link could not reach the server; callers retry later. */
export class ServerUnreachableError extends DaemonError {
  constructor(cause?: unknown) {
    super(DAEMON_RPC_ERRORS.serverUnreachable, "Server unreachable")
    this.cause = cause
  }
}

/**
 * The server refused this daemon's version: 426 `daemonUpgradeRequired` from
 * any device route, or gateway close 4001 (decision 2026-11-17-2215). The
 * daemon stops using the server until it is updated. It is a
 * `ServerUnreachableError`, so run output and receipts are kept for the
 * updated daemon instead of being dropped as refused.
 */
export class DaemonUpgradeRequiredError extends ServerUnreachableError {
  /** The release the refusing server names, when it names one. */
  readonly latest?: string
  constructor(latest?: string, cause: unknown = "daemonUpgradeRequired") {
    super(cause)
    this.message = "This daemon is too old for the server; update it."
    this.latest = latest
  }
}

/** The server has no device gateway (503 `deviceGatewayRequired`), so it has no devices. */
export class DeviceGatewayRequiredError extends ServerUnreachableError {
  constructor() {
    super("deviceGatewayRequired")
    this.message = "The server has no device gateway."
  }
}

/** A claim needs an open device session (409 `deviceSessionRequired`): redial the socket first. */
export class DeviceSessionRequiredError extends ServerUnreachableError {
  constructor() {
    super("deviceSessionRequired")
    this.message = "The server has no open session for this device."
  }
}

export class RunNotPinnedHereError extends DaemonError {
  constructor(runId: string) {
    super(
      DAEMON_RPC_ERRORS.runNotPinnedHere,
      `Run "${runId}" is pinned to another device`,
      { runId }
    )
  }
}

export class HarnessNotSupportedError extends DaemonError {
  constructor(harness: string) {
    super(
      DAEMON_RPC_ERRORS.harnessNotSupported,
      `Harness "${harness}" has no adapter in this daemon`,
      { harness }
    )
  }
}

export class InvalidIdError extends DaemonError {
  constructor(message: string, data?: unknown) {
    super(DAEMON_RPC_ERRORS.invalidId, message, data)
  }
}

/**
 * The server answered, but refused the request (4xx). Retrying the same
 * request cannot succeed.
 */
export function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof DaemonError && !(error instanceof ServerUnreachableError)
  )
}
