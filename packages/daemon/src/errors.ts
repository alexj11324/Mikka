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
