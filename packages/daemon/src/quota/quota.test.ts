import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { sanitizeError } from "./files"
import { readKeychainPassword } from "./files"
import { decodeClaudeUsage, readClaudeQuota } from "./claude"
import { decodeCodexUsage, isCodexTokenEndpoint, readCodexQuota } from "./codex"
import {
  cursorDatabasePath,
  cursorSessionCookie,
  decodeCursorUsage,
  readCursorAccessToken,
  readCursorQuota,
} from "./cursor"
import { LocalCredentialsSource } from "./local-credentials"
import { QUOTA_POLL_INTERVAL_MS, QuotaPoller } from "./poller"
import type { QuotaSource } from "./poller"

const SECRET = "sk-ant-api03-fixturetokenvalue"
const NOW = Date.parse("2026-10-16T12:00:00Z")

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mikka-quota-"))
}

function writePrivate(file: string, contents: string) {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, contents, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function syntheticJWT(
  expMs = NOW + 3_600_000,
  subject = "auth0|user_123"
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode({ sub: subject, exp: Math.floor(expMs / 1000) })}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const claudeBody = {
  five_hour: { utilization: 42.5, resets_at: "2026-10-16T17:00:00Z" },
  seven_day: { utilization: 91, resets_at: "2026-10-20T00:00:00Z" },
  seven_day_opus: { utilization: 10, resets_at: "2026-10-20T00:00:00Z" },
  seven_day_sonnet: { utilization: 4, resets_at: "2026-10-20T00:00:00Z" },
  limits: [
    {
      kind: "weekly_scoped",
      scope: { model: { display_name: "Opus" } },
      percent: 99,
      resets_at: "2026-10-20T00:00:00Z",
    },
    {
      kind: "weekly_scoped",
      scope: { model: { display_name: "Haiku" } },
      percent: 15,
      resets_at: "2026-10-20T00:00:00Z",
    },
  ],
  accessToken: SECRET,
}

const codexBody = {
  plan_type: "plus",
  access_token: SECRET,
  rate_limit: {
    primary_window: {
      used_percent: 12,
      reset_at: Math.floor(Date.parse("2026-10-16T17:00:00Z") / 1000),
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 100,
      reset_at: Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000),
      limit_window_seconds: 604_800,
    },
  },
  additional_rate_limits: [
    {
      limit_name: "gpt-5",
      rate_limit: {
        primary_window: {
          used_percent: 33,
          reset_at: Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000),
          limit_window_seconds: 604_800,
        },
      },
    },
  ],
}

const cursorBody = {
  billingCycleEnd: "2026-11-01T00:00:00Z",
  membershipType: "pro",
  accessToken: SECRET,
  individualUsage: {
    plan: {
      totalPercentUsed: 42.5,
      autoPercentUsed: 20,
      apiPercentUsed: 65,
    },
  },
}

function expectNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(SECRET)
}

describe("sanitizeError", () => {
  it("strips bearer tokens, vendor keys, and JWTs", () => {
    const jwt = syntheticJWT()
    const text = sanitizeError(
      new Error(`Bearer ${SECRET} sk-live-abcdef ya29.token ghp_abc ${jwt}`)
    )
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("sk-live-abcdef")
    expect(text).not.toContain("ya29.token")
    expect(text).not.toContain("ghp_abc")
    expect(text).not.toContain(jwt)
    expect(text).toContain("[REDACTED]")
  })
})

describe("Claude quota", () => {
  it("maps 5-hour, weekly, and per-model windows and drops echoed secrets", () => {
    const decoded = decodeClaudeUsage(claudeBody, {
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
    expect(decoded?.plan).toBe("Max 20x")
    expect(
      decoded?.windows.map((window) => [window.kind, window.model, window.used])
    ).toEqual([
      ["five_hour", undefined, 0.425],
      ["weekly", undefined, 0.91],
      ["weekly", "Opus", 0.1],
      ["weekly", "Sonnet", 0.04],
      ["weekly", "Haiku", 0.15],
    ])
    expect(decoded?.windows[0]?.resetsAt).toBe("2026-10-16T17:00:00.000Z")
    expectNoSecret(decoded)
  })

  it("reads a private credential file and does not follow a second request when the token is unchanged", async () => {
    const home = tempHome()
    const file = join(home, ".claude", ".credentials.json")
    writePrivate(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: SECRET, subscriptionType: "pro" },
      })
    )
    const urls: string[] = []
    let calls = 0
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls += 1
      urls.push(String(url))
      expect(init.redirect).toBe("error")
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${SECRET}`
      )
      if (calls === 1) return jsonResponse({}, 401)
      return jsonResponse(claudeBody)
    }) as typeof fetch
    const snapshot = await readClaudeQuota({
      credentialPath: file,
      platform: "linux",
      fetch: fetchImpl,
      now: () => NOW,
      readFile: (path) =>
        import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")),
      readKeychain: async () => ({ status: "notFound" }),
    })
    // The injected reader bypasses the mode check; the 401 re-read sees the same token.
    expect(snapshot.status).toBe("unknown")
    expect(urls).toEqual(["https://api.anthropic.com/api/oauth/usage"])
    expectNoSecret(snapshot)
    rmSync(home, { recursive: true, force: true })
  })

  it("retries once when the re-read finds a new token", async () => {
    const first = SECRET
    const second = `${SECRET}-rotated`
    let reads = 0
    const urls: string[] = []
    const snapshot = await readClaudeQuota({
      credentialPath: "/tmp/ignored",
      platform: "linux",
      now: () => NOW,
      readFile: async () => {
        reads += 1
        const token = reads === 1 ? first : second
        return JSON.stringify({
          claudeAiOauth: { accessToken: token, subscriptionType: "pro" },
        })
      },
      readKeychain: async () => ({ status: "notFound" }),
      fetch: (async (url: string) => {
        urls.push(String(url))
        if (urls.length === 1) return jsonResponse({}, 401)
        return jsonResponse(claudeBody)
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("Pro")
    expect(urls).toEqual([
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.anthropic.com/api/oauth/usage",
    ])
    expectNoSecret(snapshot)
    expect(JSON.stringify(snapshot)).not.toContain(second)
  })

  it("does not call the network for a world-readable file or a symlink", async () => {
    const home = tempHome()
    const file = join(home, ".claude", ".credentials.json")
    writePrivate(
      file,
      JSON.stringify({ claudeAiOauth: { accessToken: SECRET } })
    )
    chmodSync(file, 0o644)
    const fetchImpl = (() => {
      throw new Error("network")
    }) as typeof fetch
    const broad = await readClaudeQuota({
      credentialPath: file,
      platform: "linux",
      fetch: fetchImpl,
      now: () => NOW,
      readFile: (path) =>
        import("./files").then((mod) => mod.readSecureFile(path)),
      readKeychain: async () => ({ status: "found", value: SECRET }),
    })
    expect(broad.status).toBe("unknown")

    const target = join(home, "real.json")
    writePrivate(
      target,
      JSON.stringify({ claudeAiOauth: { accessToken: SECRET } })
    )
    const link = join(home, "link.json")
    symlinkSync(target, link)
    const linked = await readClaudeQuota({
      credentialPath: link,
      platform: "linux",
      fetch: fetchImpl,
      now: () => NOW,
      readFile: (path) =>
        import("./files").then((mod) => mod.readSecureFile(path)),
      readKeychain: async () => ({ status: "notFound" }),
    })
    expect(linked.status).toBe("unknown")
    expectNoSecret(broad)
    expectNoSecret(linked)
    rmSync(home, { recursive: true, force: true })
  })

  it("uses the keychain on macOS when the file is absent", async () => {
    const seen: string[] = []
    const snapshot = await readClaudeQuota({
      credentialPath: join(tempHome(), "missing.json"),
      platform: "darwin",
      now: () => NOW,
      readFile: async () => null,
      readKeychain: async () => ({
        status: "found",
        value: JSON.stringify({
          claudeAiOauth: {
            accessToken: SECRET,
            subscriptionType: "max",
            rateLimitTier: "max_20x",
          },
        }),
      }),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(String(url))
        expect(init.redirect).toBe("error")
        return jsonResponse(claudeBody)
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("Max 20x")
    expect(seen).toEqual(["https://api.anthropic.com/api/oauth/usage"])
    expectNoSecret(snapshot)
  })

  it("does not send an expired token", async () => {
    const snapshot = await readClaudeQuota({
      credentialPath: "/tmp/ignored",
      platform: "linux",
      now: () => NOW,
      readFile: async () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: SECRET, expiresAt: NOW - 1 },
        }),
      readKeychain: async () => ({ status: "notFound" }),
      fetch: (() => {
        throw new Error("network")
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("unknown")
    expectNoSecret(snapshot)
  })
})

describe("Codex quota", () => {
  it("maps 5-hour, weekly, and per-model windows", () => {
    const decoded = decodeCodexUsage(codexBody)
    expect(decoded?.plan).toBe("Plus")
    expect(
      decoded?.windows.map((window) => [window.kind, window.model, window.used])
    ).toEqual([
      ["five_hour", undefined, 0.12],
      ["weekly", undefined, 1],
      ["weekly", "gpt-5", 0.33],
    ])
    expectNoSecret(decoded)
  })

  it("reads auth.json without writing it or calling the token endpoint", async () => {
    const home = tempHome()
    const file = join(home, "auth.json")
    const contents = `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          access_token: SECRET,
          refresh_token: `${SECRET}-refresh`,
          account_id: "acct_1",
        },
      },
      null,
      2
    )}\n`
    writePrivate(file, contents)
    const before = statSync(file).mtimeMs
    const urls: string[] = []
    const snapshot = await readCodexQuota({
      authPath: file,
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(String(url))
        expect(isCodexTokenEndpoint(String(url))).toBe(false)
        expect(init.redirect).toBe("error")
        expect(init.method).toBe("GET")
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBe(`Bearer ${SECRET}`)
        expect(headers["ChatGPT-Account-Id"]).toBe("acct_1")
        return jsonResponse(codexBody)
      }) as typeof fetch,
      readFile: (path) =>
        import("./files").then((mod) => mod.readSecureFile(path)),
    })
    expect(snapshot.status).toBe("ok")
    expect(readFileSync(file, "utf8")).toBe(contents)
    expect(statSync(file).mtimeMs).toBe(before)
    expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"])
    expectNoSecret(snapshot)
    rmSync(home, { recursive: true, force: true })
  })

  it("does not refresh when the usage endpoint returns 401", async () => {
    const urls: string[] = []
    const snapshot = await readCodexQuota({
      authPath: "/tmp/ignored",
      now: () => NOW,
      readFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: SECRET },
        }),
      fetch: (async (url: string) => {
        urls.push(String(url))
        return jsonResponse({ error: SECRET }, 401)
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("unknown")
    expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"])
    expectNoSecret(snapshot)
  })

  it("ignores an API-key login", async () => {
    const snapshot = await readCodexQuota({
      authPath: "/tmp/ignored",
      now: () => NOW,
      readFile: async () =>
        JSON.stringify({
          auth_mode: "apikey",
          tokens: { access_token: SECRET },
        }),
      fetch: (() => {
        throw new Error("network")
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("unknown")
  })
})

describe("Cursor quota", () => {
  it("follows each platform's state database path", () => {
    expect(cursorDatabasePath("darwin", "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    )
    expect(cursorDatabasePath("win32", "C:\\Users\\dev")).toBe(
      join(
        "C:\\Users\\dev",
        "AppData",
        "Roaming",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    )
    expect(cursorDatabasePath("linux", "/home/dev")).toBe(
      "/home/dev/.config/Cursor/User/globalStorage/state.vscdb"
    )
  })

  it("builds a session cookie and refuses an expired token", () => {
    const token = syntheticJWT()
    expect(cursorSessionCookie(token, NOW)).toBe(
      `WorkosCursorSessionToken=user_123%3A%3A${token}`
    )
    expect(cursorSessionCookie(syntheticJWT(NOW + 30_000), NOW)).toBeNull()
    expect(cursorSessionCookie("not-a-jwt", NOW)).toBeNull()
  })

  it("maps monthly, Auto, and API meters", () => {
    const decoded = decodeCursorUsage(cursorBody)
    expect(decoded?.plan).toBe("Pro")
    expect(
      decoded?.windows.map((window) => [window.kind, window.meter, window.used])
    ).toEqual([
      ["monthly", undefined, 0.425],
      ["other", "auto", 0.2],
      ["other", "api", 0.65],
    ])
    expect(decoded?.windows[0]?.resetsAt).toBe("2026-11-01T00:00:00.000Z")
    expectNoSecret(decoded)
  })

  it("uses the team on-demand meter when that is the only reading", () => {
    const decoded = decodeCursorUsage({
      billingCycleEnd: "2026-11-01T00:00:00Z",
      membershipType: "enterprise",
      individualUsage: { overall: { enabled: false, used: 0, limit: null } },
      teamUsage: { onDemand: { enabled: true, used: 2500, limit: 10000 } },
    })
    expect(decoded?.plan).toBe("Enterprise")
    expect(decoded?.windows).toEqual([
      {
        kind: "other",
        meter: "team_on_demand",
        used: 0.25,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ])
  })

  it("reads the token from the state database without creating or rewriting it", async () => {
    const home = tempHome()
    const databasePath = cursorDatabasePath("linux", home)
    mkdirSync(join(databasePath, ".."), { recursive: true })
    const token = syntheticJWT()
    const db = new DatabaseSync(databasePath)
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      token
    )
    db.close()
    const before = readFileSync(databasePath)
    expect(await readCursorAccessToken(join(home, "missing.vscdb"))).toBeNull()
    expect(await readCursorAccessToken(databasePath)).toBe(token)
    expect(readFileSync(databasePath).equals(before)).toBe(true)

    const link = join(home, "state-link.vscdb")
    symlinkSync(databasePath, link)
    await expect(readCursorAccessToken(link)).rejects.toThrow(/Refusing/)

    const urls: string[] = []
    const snapshot = await readCursorQuota({
      databasePath,
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(String(url))
        const headers = init.headers as Record<string, string>
        expect(headers.Cookie).toContain(token)
        expect(headers.Authorization).toBeUndefined()
        expect(init.redirect).toBe("error")
        return jsonResponse(cursorBody)
      }) as typeof fetch,
    })
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("Pro")
    expect(urls).toEqual(["https://cursor.com/api/usage-summary"])
    expectNoSecret(snapshot)
    expect(JSON.stringify(snapshot)).not.toContain(token)
    rmSync(home, { recursive: true, force: true })
  })
})

describe("local credential source", () => {
  it("returns unknown for every vendor when nothing is signed in and does not throw", async () => {
    const home = tempHome()
    const source = new LocalCredentialsSource({
      home,
      platform: "linux",
      now: () => NOW,
      fetch: (() => {
        throw new Error("network")
      }) as typeof fetch,
    })
    const quotas = await source.read()
    expect(quotas.map((quota) => quota.vendor)).toEqual([
      "claude_code",
      "codex",
      "cursor",
    ])
    expect(quotas.every((quota) => quota.status === "unknown")).toBe(true)
    expectNoSecret(quotas)
    rmSync(home, { recursive: true, force: true })
  })

  it("reads all three vendors from one home directory", async () => {
    const home = tempHome()
    writePrivate(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: SECRET, subscriptionType: "pro" },
      })
    )
    writePrivate(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: SECRET } })
    )
    const token = syntheticJWT()
    const databasePath = cursorDatabasePath("linux", home)
    mkdirSync(join(databasePath, ".."), { recursive: true })
    const db = new DatabaseSync(databasePath)
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      token
    )
    db.close()
    const urls: string[] = []
    const source = new LocalCredentialsSource({
      home,
      platform: "linux",
      now: () => NOW,
      fetch: (async (url: string) => {
        urls.push(String(url))
        if (String(url).includes("anthropic")) return jsonResponse(claudeBody)
        if (String(url).includes("chatgpt")) return jsonResponse(codexBody)
        return jsonResponse(cursorBody)
      }) as typeof fetch,
    })
    const quotas = await source.read()
    expect(quotas.map((quota) => quota.status)).toEqual(["ok", "ok", "ok"])
    expect(urls).toHaveLength(3)
    expectNoSecret(quotas)
    expect(JSON.stringify(quotas)).not.toContain(token)
    rmSync(home, { recursive: true, force: true })
  })
})

describe("quota poller", () => {
  it("never polls faster than every three minutes", () => {
    const source: QuotaSource = {
      id: "local_credentials",
      read: async () => [],
    }
    expect(new QuotaPoller(source, { intervalMs: 10 }).intervalMs).toBe(
      QUOTA_POLL_INTERVAL_MS
    )
    expect(QUOTA_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(3 * 60 * 1000)
  })

  it("turns a thrown read into unknown and keeps the secret out of the log", async () => {
    const lines: string[] = []
    const source: QuotaSource = {
      id: "local_credentials",
      read: async () => {
        throw new Error(`Bearer ${SECRET}`)
      },
    }
    const poller = new QuotaPoller(source, {
      log: {
        info(bindings: unknown, message?: string) {
          lines.push(`${message ?? ""} ${JSON.stringify(bindings)}`)
        },
        warn(bindings: unknown, message?: string) {
          lines.push(`${message ?? ""} ${JSON.stringify(bindings)}`)
        },
      } as never,
    })
    await poller.refresh()
    const report = poller.snapshot()
    expect(report.observedAt).not.toBeNull()
    expect(report.quotas.every((quota) => quota.status === "unknown")).toBe(
      true
    )
    expectNoSecret(report)
    expect(lines.join("\n")).not.toContain(SECRET)
    expect(lines.join("\n")).toContain("[REDACTED]")
  })

  it("does not start a second read while one is in flight", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source: QuotaSource = {
      id: "local_credentials",
      async read() {
        calls += 1
        await gate
        return []
      },
    }
    const poller = new QuotaPoller(source)
    const first = poller.refresh()
    const second = poller.refresh()
    release?.()
    await first
    await second
    expect(calls).toBe(1)
  })
})

describe("keychain lookup", () => {
  it("decodes a hex password and classifies a missing item", async () => {
    const payload = JSON.stringify({ claudeAiOauth: { accessToken: SECRET } })
    const hex = Buffer.from(payload, "utf8").toString("hex")
    const found = await readKeychainPassword(
      "Claude Code-credentials",
      [null],
      async () => ({
        stdout: `${hex}\n`,
      })
    )
    expect(found).toEqual({ status: "found", value: payload })

    const missing = await readKeychainPassword(
      "Claude Code-credentials",
      ["ada", null],
      async () => {
        throw Object.assign(
          new Error("The specified item could not be found"),
          { code: 44 }
        )
      }
    )
    expect(missing.status).toBe("notFound")
  })
})
