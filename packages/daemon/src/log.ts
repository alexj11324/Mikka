import pino, { type Logger } from "pino"
import { createStream, type RotatingFileStream } from "rotating-file-stream"

export type { Logger }

export interface LoggerOptions {
  /** Directory for the rotating `daemon.log`; omit to skip file output. */
  dir?: string
  /** Also write to stdout (dev and headless foreground runs). */
  stdout?: boolean
  level?: string
}

/**
 * Daemon logger: a size-rotated file in the data dir plus stdout in dev.
 * Every line carries `run_id` (null outside a run); run code uses
 * `logger.child({ run_id })`. Logs are diagnostics only, never a product view.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const streams: pino.StreamEntry[] = []
  let file: RotatingFileStream | undefined
  if (options.dir) {
    file = createStream("daemon.log", {
      path: options.dir,
      size: "5M",
      maxFiles: 3,
      mode: 0o600,
    })
    streams.push({ stream: file })
  }
  if (options.stdout) streams.push({ stream: process.stdout })
  const level = options.level ?? process.env.ORVILO_LOG_LEVEL ?? "info"
  // Defense in depth: quota code never logs credentials, and neither does
  // anything else that accidentally binds one of these keys (ADR 0027).
  const redact = {
    paths: [
      "accessToken",
      "access_token",
      "refresh_token",
      "refreshToken",
      "id_token",
      "idToken",
      "authorization",
      "Authorization",
      "cookie",
      "Cookie",
      "password",
      "secret",
      "credential",
      "*.accessToken",
      "*.access_token",
      "*.refresh_token",
      "*.refreshToken",
      "*.authorization",
      "*.Authorization",
      "*.cookie",
      "*.Cookie",
    ],
    censor: "[REDACTED]",
  }
  if (streams.length === 0) return pino({ level, enabled: false, redact })
  const logger = pino(
    { level, base: { pid: process.pid, run_id: null }, redact },
    pino.multistream(streams)
  )
  if (file) files.set(logger, file)
  return logger
}

const files = new WeakMap<Logger, RotatingFileStream>()

/** Closes the log file of a logger made by `createLogger`. */
export function closeLogger(logger: Logger): Promise<void> {
  const file = files.get(logger)
  if (!file) return Promise.resolve()
  files.delete(logger)
  return new Promise((resolve) => file.end(resolve))
}
