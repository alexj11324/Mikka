// Read-only access to credential files and the macOS keychain.
// Adapted from codeburn (MIT), Copyright (c) 2026 AgentSeal.
// See packages/daemon/THIRD_PARTY_NOTICES.md.
// Nothing here writes a credential file.
import { execFile } from "node:child_process"
import { constants, type Stats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { promisify } from "node:util"

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const execFileAsync = promisify(execFile)

export const KEYCHAIN_TIMEOUT_MS = 30_000
const MAX_CREDENTIAL_BYTES = 64 * 1024

export type KeychainOutcome =
  | { status: "found"; value: string }
  | { status: "notFound" }
  | { status: "accessDenied" }

export type KeychainExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/\0/g, "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED]")
    .slice(0, 240)
}

function decodeKeychainValue(raw: string): string {
  const trimmed = raw.trim()
  if (
    trimmed.length >= 2 &&
    trimmed.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(trimmed)
  ) {
    return Buffer.from(trimmed, "hex").toString("utf8")
  }
  return raw
}

function classifyKeychainError(error: unknown): "notFound" | "accessDenied" {
  const err = error as {
    code?: number | string
    stderr?: string
    message?: string
  }
  const code = typeof err.code === "number" ? err.code : undefined
  const text = `${err.stderr ?? ""} ${err.message ?? ""}`.toLowerCase()
  if (
    code === 44 ||
    text.includes("could not be found") ||
    text.includes("specified item could not be found")
  ) {
    return "notFound"
  }
  return "accessDenied"
}

function safeAccount(account: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(account)
}

/**
 * Reads a generic-password item via `/usr/bin/security`. `null` in `accounts`
 * is a service-only lookup. The secret is returned only to the caller.
 */
export async function readKeychainPassword(
  service: string,
  accounts: (string | null)[] = [null],
  exec: KeychainExec = execFileAsync
): Promise<KeychainOutcome> {
  // Tests inject `exec` so the decoder can run on Linux. The real binary
  // exists only on macOS.
  if (process.platform !== "darwin" && exec === execFileAsync) {
    return { status: "notFound" }
  }
  let denied = false
  for (const account of accounts) {
    if (account !== null && !safeAccount(account)) continue
    const args = [
      "find-generic-password",
      "-s",
      service,
      ...(account ? ["-a", account] : []),
      "-w",
    ]
    try {
      const { stdout } = await exec("/usr/bin/security", args, {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: MAX_CREDENTIAL_BYTES,
      })
      if (stdout && stdout.trim()) {
        return { status: "found", value: decodeKeychainValue(stdout) }
      }
    } catch (error) {
      if (classifyKeychainError(error) === "accessDenied") denied = true
    }
  }
  return denied ? { status: "accessDenied" } : { status: "notFound" }
}

function assertRegularFile(stats: Stats, filePath: string): void {
  if (!stats.isFile())
    throw new Error(`Credential path is not a regular file: ${filePath}`)
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`Credential file permissions are too broad: ${filePath}`)
  }
}

/** Owner-only regular file, never a symlink. `null` when the path is missing. */
export async function readSecureFile(
  filePath: string,
  maxBytes = MAX_CREDENTIAL_BYTES
): Promise<string | null> {
  let before: Stats
  try {
    before = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (before.isSymbolicLink())
    throw new Error(`Refusing symbolic link: ${filePath}`)
  assertRegularFile(before, filePath)
  if (before.size > maxBytes) {
    throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)
  }

  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW)
  try {
    const after = await handle.stat()
    assertRegularFile(after, filePath)
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`Credential file changed while opening: ${filePath}`)
    }
    if (after.size > maxBytes) {
      throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)
    }
    const text = await handle.readFile({ encoding: "utf8" })
    return text.length > 0 ? text : null
  } finally {
    await handle.close()
  }
}
