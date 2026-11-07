/** The bundled renderer receives public identity and local transport handles only. */
export interface BundledSession {
  user: { id: string; name: string; email: string; image?: string | null }
  session: { id: string }
}

export interface BundledSignIn {
  provider?: 'google' | 'github'
  next?: string
  locale?: 'zh-CN' | 'en'
  addAccount?: boolean
  mode?: 'sign-in' | 'sign-up'
}

export interface BundledLiveEvent {
  id: string
  type: 'open' | 'message' | 'close' | 'error'
  data?: string
}

export interface BundledViewerInput { botId: string; mode: 'view' | 'control'; takeover?: boolean; subagentId?: string }
export interface BundledViewerEvent { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: Uint8Array }
export type BundledViewerResult = { status: number; body: { url: string; expiresAt: string } | { error: string } }

/** A server the desktop can talk to (#1557). Public facts only, from its discovery read. */
export interface BundledServer {
  /** Origin plus base path, exactly as probed. */
  url: string
  /** Mikka Cloud, the app's built-in server. */
  cloud: boolean
  name: string | null
  version: string | null
  /** Signed-in accounts on it. */
  accounts: number
  /** The sign-in methods it reported; null for the built-in server (read from its config instead). */
  signIn: { google: boolean; github: boolean; email: boolean } | null
}
export interface BundledServerState {
  /** The server the window talks to: the current account's, or the sign-in page's. */
  current: BundledServer
  /** Where the next sign-in goes. */
  target: BundledServer
  /** Every server with a signed-in account, plus the built-in one. */
  servers: BundledServer[]
}
export type BundledServerProbe =
  | { status: 'ok'; server: BundledServer }
  | { status: 'invalid_address' | 'https_required' | 'unreachable' | 'not_mikka' }
  | { status: 'server_update_required'; version: string | null }
  | { status: 'app_update_required'; minimum: string | null }

export interface BundledBridge {
  session(): Promise<BundledSession | null>
  signIn(input: BundledSignIn): Promise<void>
  signInEmail(input: { email: string; password: string }): Promise<{ code?: string; status?: number } | null>
  signOut(): Promise<void>
  accounts(): Promise<{ providerId: string }[]>
  linkAccount(provider: 'google' | 'github'): Promise<void>
  onSessionChanged(listener: () => void): () => void
  /** Absent on desktops from before #1557. */
  server?: {
    state(): Promise<BundledServerState>
    /** Reads the address's discovery once; main remembers a good answer for select(). */
    probe(address: string): Promise<BundledServerProbe>
    /** The built-in server (null) or one probed in the last ten minutes. */
    select(url: string | null): Promise<BundledServerState>
    /** Signs out every account on that server and forgets it. */
    disconnect(url: string): Promise<BundledServerState>
  }
  live: {
    prepare(workspaceId: string): Promise<{ id: string; expiresAt: number } | null>
    connect(id: string): Promise<void>
    send(id: string, data: string): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: BundledLiveEvent) => void): () => void
  }
  viewer: {
    prepare(input: BundledViewerInput): Promise<BundledViewerResult>
    connect(id: string): Promise<void>
    send(id: string, data: Uint8Array): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: BundledViewerEvent) => void): () => void
  }
}

export const BUNDLED_IPC = {
  session: 'bundled:session', signIn: 'bundled:sign-in', signInEmail: 'bundled:sign-in-email',
  signOut: 'bundled:sign-out', accounts: 'bundled:accounts', linkAccount: 'bundled:link-account',
  sessionChanged: 'bundled:session-changed', livePrepare: 'bundled:live-prepare',
  liveConnect: 'bundled:live-connect', liveSend: 'bundled:live-send', liveClose: 'bundled:live-close',
  liveEvent: 'bundled:live-event',
  viewerPrepare: 'bundled:viewer-prepare', viewerConnect: 'bundled:viewer-connect',
  viewerSend: 'bundled:viewer-send', viewerClose: 'bundled:viewer-close', viewerEvent: 'bundled:viewer-event',
  serverState: 'bundled:server-state', serverProbe: 'bundled:server-probe', serverSelect: 'bundled:server-select',
  serverDisconnect: 'bundled:server-disconnect',
  /** Synchronous, once per page load: the preload's `app.serverUrl`. */
  serverUrl: 'bundled:server-url',
} as const
