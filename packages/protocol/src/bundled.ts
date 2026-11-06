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

export interface BundledBridge {
  session(): Promise<BundledSession | null>
  signIn(input: BundledSignIn): Promise<void>
  signInEmail(input: { email: string; password: string }): Promise<{ code?: string; status?: number } | null>
  signOut(): Promise<void>
  accounts(): Promise<{ providerId: string }[]>
  linkAccount(provider: 'google' | 'github'): Promise<void>
  onSessionChanged(listener: () => void): () => void
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
} as const
