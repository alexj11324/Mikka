// The preload bridge (`window.mikka`): the only surface the sandboxed
// renderer has into the Electron main process. The preload script and the
// browser shim used by `dev:ui` both implement `MikkaBridge`, so they are
// type-checked against the same contract. Main validates every payload with
// the schemas below because the renderer is untrusted.
import { z } from "zod"

import type { QuotaSnapshotReport } from "./quota"
import { authProvider, sessionUser, type AccessToken } from "./auth"

export const FLAVORS = ["prod", "dev"] as const
export type Flavor = (typeof FLAVORS)[number]

export const LANGUAGES = ["zh-CN", "en"] as const
export type Language = (typeof LANGUAGES)[number]

export const languagePreference = z.enum(["system", ...LANGUAGES])
export type LanguagePreference = z.infer<typeof languagePreference>

export const themePreference = z.enum(["system", "light", "dark"])
export type ThemePreference = z.infer<typeof themePreference>

/** An in-app path such as `/issue/ORV-15`; never another origin. */
const appHref = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)/)

/**
 * The kinds that become a desktop system notification (interaction spec 8.3):
 * the ones where an agent is waiting on the person, and a finished thread
 * (线程完成, on by default; Alex, 2026-10-31). Everything else stays in the
 * inbox.
 */
export const DESKTOP_NOTIFICATION_KINDS = [
  "review",
  "awaiting",
  "failed",
  "finished",
] as const
export type DesktopNotificationKind =
  (typeof DESKTOP_NOTIFICATION_KINDS)[number]

/**
 * One system notification the renderer asks main to show (ADR 0056). Main
 * remembers `id`, so the same event never pops twice; `href` is the in-app
 * page opened on a click. The renderer is untrusted, so main re-validates.
 */
export const desktopNotification = z.object({
  /** The `notification` row id. */
  id: z.string().min(1).max(200),
  kind: z.enum(DESKTOP_NOTIFICATION_KINDS),
  /** `ORV-12 · 等你验收`; the issue number is always in it. */
  title: z.string().min(1).max(300),
  /** The issue title. */
  body: z.string().max(1_000),
  href: appHref,
})
export type DesktopNotification = z.infer<typeof desktopNotification>

/** The Dock badge: the inbox's unread pending count; 0 hides it. */
export const desktopBadgeCount = z.number().int().min(0).max(9_999)

/** One titlebar tab: its own back/forward entries and where it is in them. */
export const savedTab = z.object({
  entries: z.array(appHref).min(1).max(50),
  index: z.number().int().min(0).max(49),
})
export type SavedTab = z.infer<typeof savedTab>

/** The titlebar tabs, restored on the next start. */
export const savedTabs = z.object({
  items: z.array(savedTab).max(50),
  active: z.number().int().min(0).max(49),
})
export type SavedTabs = z.infer<typeof savedTabs>

export const firstDayOfWeekPreference = z.enum(["monday", "sunday", "saturday"])
export type FirstDayOfWeekPreference = z.infer<typeof firstDayOfWeekPreference>

/** Which key press sends a comment; ⌘/Ctrl+Enter or Enter alone. */
export const commentSubmitKeyPreference = z.enum(["mod+enter", "enter"])
export type CommentSubmitKeyPreference = z.infer<
  typeof commentSubmitKeyPreference
>

export const settingsSchema = z.object({
  language: languagePreference,
  theme: themePreference,
  /** Sidebar expanded (true) or collapsed offcanvas (false); ⌘B and `[`. */
  sidebarOpen: z.boolean(),
  /** Titlebar tabs; empty until the app has saved them once. */
  tabs: savedTabs,
  /** Send anonymous usage events (ADR 0033); off by choice in Settings. */
  telemetry: z.boolean(),
  /** Which day a week starts on in date pickers. */
  firstDayOfWeek: firstDayOfWeekPreference,
  /** Which key press sends a comment. */
  commentSubmitKey: commentSubmitKeyPreference,
})
export type Settings = z.infer<typeof settingsSchema>
export type SettingsKey = keyof Settings

export const DEFAULT_SETTINGS: Settings = {
  language: "system",
  theme: "system",
  sidebarOpen: true,
  tabs: { items: [], active: 0 },
  telemetry: true,
  firstDayOfWeek: "monday",
  commentSubmitKey: "mod+enter",
}

/**
 * Every settings key, for validating a `settings.set` from the renderer.
 * Derived from DEFAULT_SETTINGS so a new key cannot be added to the schema
 * and forgotten here.
 */
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as [
  SettingsKey,
  ...SettingsKey[],
]

/** Validates one `settings.set` call coming from the renderer. */
export function parseSettingsUpdate<K extends SettingsKey>(
  key: unknown,
  value: unknown
): { key: K; value: Settings[K] } {
  const name = z.enum(SETTINGS_KEYS).parse(key) as K
  const parsed = settingsSchema.shape[name].parse(value) as Settings[K]
  return { key: name, value: parsed }
}

/** Reads a stored settings object, falling back to defaults per field. */
export function parseStoredSettings(raw: unknown): Settings {
  const input = typeof raw === "object" && raw !== null ? raw : {}
  const result = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    const parsed = settingsSchema.shape[key].safeParse(
      (input as Record<string, unknown>)[key]
    )
    if (parsed.success) Object.assign(result, { [key]: parsed.data })
  }
  return result
}

/** What the renderer may know about the session; never the session token. */
export const authState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed_out") }),
  z.object({ status: z.literal("signing_in"), provider: authProvider }),
  z.object({ status: z.literal("signed_in"), user: sessionUser }),
  z.object({
    status: z.literal("update_required"),
    minVersion: z.string(),
  }),
  z.object({ status: z.literal("error"), code: z.string() }),
])
export type AuthState = z.infer<typeof authState>

/**
 * This computer's daemon as the app sees it (Settings › 我的设备). Never
 * the device credential: main signs the daemon in and keeps that to itself.
 */
export const localDevice = z.object({
  /** Whether the daemon on this computer answers. */
  status: z.enum(["online", "connecting", "offline"]),
  /** The device row this daemon registered, once it has. */
  deviceId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** The daemon holds a device credential. */
  signedIn: z.boolean(),
  /** The daemon's link to the server; null while the daemon is offline. */
  server: z.enum(["online", "offline", "unregistered"]).nullable(),
})
export type LocalDevice = z.infer<typeof localDevice>

/** Which workspace the daemon should serve; main signs it in for that one. */
export const deviceLinkRequest = z.object({ workspaceId: z.uuid() })

/** A folder the person picked to allow-list, checked to be a git repo. */
export const pickedRepo = z.object({
  /** The repo's top level (a subfolder pick resolves to it). */
  path: z.string().min(1).max(4_000),
  name: z.string().max(500),
  /** `origin` (or the first remote), null when the repo has none. */
  remoteUrl: z.string().max(2_000).nullable(),
})
export type PickedRepo = z.infer<typeof pickedRepo>

export const pickRepoResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("picked"), repo: pickedRepo }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("not_a_repo"), path: z.string() }),
])
export type PickRepoResult = z.infer<typeof pickRepoResult>

export interface SshInstallState {
  id: string; target: string; step: 'login' | 'check' | 'install' | 'service' | 'connect'
  status: 'fingerprint' | 'running' | 'online' | 'failed'; deviceId?: string; fingerprint?: string; keyType?: string; reason?: string; retryable?: boolean
}

export interface MikkaBridge {
  ssh?: {
    onChange(listener: (state: SshInstallState) => void): () => void
    hosts(): Promise<{ alias: string; user: string; hostName: string; port: number }[]>
    begin(target: string): Promise<SshInstallState | null>
    cancel(id: string): Promise<SshInstallState | null>
    accept(id: string): Promise<SshInstallState | null>
    state(): Promise<SshInstallState | null>
  }

  app: {
    /** App version from `apps/desktop/package.json`. */
    version: string
    flavor: Flavor
    /** `electron` inside the desktop app, `browser` under `dev:ui`. */
    runtime: "electron" | "browser"
    /** API server origin (relay, REST). */
    serverUrl: string
    /** zero-cache origin. */
    zeroUrl: string
    /**
     * Opens an app-origin URL in the system browser. Used for OAuth, which
     * must not run in an embedded Electron window. Main rejects other origins.
     */
    openExternal(url: string): Promise<void>
    /** Start a one-shot loopback listener and return its callback URL. */
    prepareAuth(state: string): Promise<string>
    /**
     * The version of an update already downloaded in the background, or null.
     * Only a downloaded update is surfaced. Absent on older desktop builds.
     */
    updateReady?(): Promise<string | null>
    /** Called once an update finishes downloading; returns an unsubscribe. */
    onUpdateReady?(listener: (version: string) => void): () => void
    /** Quits and installs the downloaded update. */
    installUpdate?(): Promise<void>
  }
  /**
   * Login. The long-lived session token stays in the main process (macOS
   * Keychain via safeStorage); the renderer only gets short-lived JWTs.
   */
  auth: {
    getState(): Promise<AuthState>
    /** Opens the system browser on the provider's sign-in page. */
    signIn(provider: z.infer<typeof authProvider>): Promise<AuthState>
    /** Dev flavor only: signs in the dev user through the server's dev login. */
    devSignIn(): Promise<AuthState>
    signOut(): Promise<AuthState>
    /** Short-lived JWT for zero-cache and the relay. */
    getToken(): Promise<AccessToken>
    /**
     * Opens the system browser on a provider's consent screen to link it to
     * the signed-in person, or to refresh a grant we already hold (ORV-26).
     * The flow finishes in the browser, so this resolves once it is open.
     *
     * It lives here rather than on the server because starting it needs the
     * Better Auth session, which never leaves the main process; the server
     * only ever sees the resulting `account` row. The provider is a plain
     * string because it comes from the server's own account list, and main
     * checks it against the providers this build signs in with.
     */
    linkAccount(provider: string): Promise<void>
    /** Called whenever the state changes; returns an unsubscribe function. */
    onChange(listener: (state: AuthState) => void): () => void
  }
  settings: {
    getAll(): Promise<Settings>
    set<K extends SettingsKey>(key: K, value: Settings[K]): Promise<Settings>
  }
  /**
   * Desktop system notifications and the macOS Dock badge (ADR 0056). Only
   * main shows notifications; the renderer just reports the events it sees
   * in the inbox. No-ops in the browser shim.
   */
  notifications: {
    /** Shows one system notification; main shows each `id` at most once. */
    show(notification: DesktopNotification): Promise<void>
    /** Sets the Dock badge; `0` hides it. */
    setBadge(count: number): Promise<void>
    /** Called when a notification is clicked; returns an unsubscribe. */
    onClick(listener: (href: string) => void): () => void
    /**
     * Subscribes the caller as the listener and returns a click that arrived
     * first (the window was closed, so main kept it); null when there is
     * none. A click is handed over at most once.
     */
    consumePendingClick(): Promise<string | null>
  }
  /**
   * This computer as a device (ADR 0026). Main signs the daemon in with the
   * person's session; the renderer only learns the outcome.
   */
  device: {
    status(): Promise<LocalDevice>
    /**
     * Makes sure the daemon is signed in as the current person for this
     * workspace, running the device login in main when it is not.
     */
    link(workspaceId: string): Promise<LocalDevice>
    /** Native folder picker; main checks the folder is in a git repo. */
    pickRepo(): Promise<PickRepoResult>
  }
  /** Subscription numbers from the local daemon. Never a vendor credential. */
  quota: {
    get(): Promise<QuotaSnapshotReport>
  }
  /** Deliverable previews, isolated from the app (see `./preview`). */
  preview: {
    /** Hands an HTML page to main; returns the URL to load in the iframe. */
    html(html: string): Promise<string>
  }
}
