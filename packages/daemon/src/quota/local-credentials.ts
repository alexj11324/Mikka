// `QuotaSource` that reads the logins Claude Code, Codex, and Cursor already
// stored on this machine. Credentials stay in the process that calls the
// vendor; the returned snapshots are numbers only (ADR 0027).
import { homedir } from "node:os"
import { join } from "node:path"

import {
  quotaSnapshotSchema,
  type QuotaSnapshot,
  type QuotaVendor,
} from "@orvilo/protocol"

import type { Logger } from "../log"
import { readClaudeQuota } from "./claude"
import { readCodexQuota } from "./codex"
import { cursorDatabasePath, readCursorQuota } from "./cursor"
import { readKeychainPassword, readSecureFile, sanitizeError } from "./files"
import type { KeychainOutcome } from "./files"

const KEYCHAIN_SERVICE = "Claude Code-credentials"

export interface LocalCredentialsOptions {
  home?: string
  platform?: NodeJS.Platform
  fetch?: typeof fetch
  now?: () => number
  readFile?: (path: string) => Promise<string | null>
  readKeychain?: () => Promise<KeychainOutcome>
  /** macOS account tried before the service-only keychain lookup. */
  user?: string
  log?: Logger
}

function claudeCredentialPath(home: string): string {
  return join(home, ".claude", ".credentials.json")
}

function codexAuthPath(home: string): string {
  return join(home, ".codex", "auth.json")
}

function unknown(vendor: QuotaVendor, observedAt: string): QuotaSnapshot {
  return {
    vendor,
    source: "local_credentials",
    status: "unknown",
    plan: null,
    windows: [],
    observedAt,
  }
}

export class LocalCredentialsSource {
  readonly id = "local_credentials" as const

  constructor(private readonly options: LocalCredentialsOptions = {}) {}

  async read(signal?: AbortSignal): Promise<QuotaSnapshot[]> {
    const home = this.options.home ?? homedir()
    const platform = this.options.platform ?? process.platform
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const now = this.options.now ?? Date.now
    const readFile = this.options.readFile ?? readSecureFile
    const user = this.options.user ?? process.env.USER
    const readKeychain =
      this.options.readKeychain ??
      (() =>
        readKeychainPassword(KEYCHAIN_SERVICE, user ? [user, null] : [null]))
    const log = (vendor: QuotaVendor) => (detail: string) => {
      this.options.log?.warn({ vendor, detail }, "quota read failed")
    }
    const readers: Promise<QuotaSnapshot>[] = [
      readClaudeQuota({
        credentialPath: claudeCredentialPath(home),
        platform,
        fetch: fetchImpl,
        now,
        readFile,
        readKeychain,
        signal,
        log: log("claude_code"),
      }),
      readCodexQuota({
        authPath: codexAuthPath(home),
        fetch: fetchImpl,
        now,
        readFile,
        signal,
        log: log("codex"),
      }),
      readCursorQuota({
        databasePath: cursorDatabasePath(platform, home),
        fetch: fetchImpl,
        now,
        signal,
        log: log("cursor"),
      }),
    ]
    const settled = await Promise.all(
      readers.map(async (reader, index) => {
        const vendor =
          (["claude_code", "codex", "cursor"] as const)[index] ?? "claude_code"
        try {
          const snapshot = await reader
          const parsed = quotaSnapshotSchema.safeParse(snapshot)
          return parsed.success
            ? parsed.data
            : unknown(vendor, new Date(now()).toISOString())
        } catch (error) {
          if (!signal?.aborted) {
            this.options.log?.warn(
              { vendor, detail: sanitizeError(error) },
              "quota read failed"
            )
          }
          return unknown(vendor, new Date(now()).toISOString())
        }
      })
    )
    return settled
  }
}
