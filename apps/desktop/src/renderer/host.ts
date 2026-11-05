import type { MikkaBridge } from '@mikka/protocol/bridge'

export type DesktopSession = {
  user: { id: string; name: string; email: string; image?: string | null }
  /** Public database id for approval-cache isolation; never a session token. */
  session: { id: string }
}
export type DesktopSignIn = { provider?: 'google' | 'github'; mode?: 'sign-in' | 'sign-up'; next: string; locale: 'zh-CN' | 'en'; addAccount?: boolean }
export type DesktopLiveEvent = { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: string }
export type DesktopViewerEvent = { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: Uint8Array }
export interface RendererHost {
  session(): Promise<DesktopSession | null>
  signIn(input: DesktopSignIn): Promise<void>
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
    onEvent(listener: (event: DesktopLiveEvent) => void): () => void
  }
  viewer: {
    prepare(input: { botId: string; mode: 'view' | 'control'; takeover?: boolean; subagentId?: string }): Promise<{ status: number; body: { url: string; expiresAt: string } | { error: string } }>
    connect(id: string): Promise<void>
    send(id: string, data: Uint8Array): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: DesktopViewerEvent) => void): () => void
  }
}

export function rendererHost(): RendererHost {
  const bridge = (window as Window & { mikka?: MikkaBridge & { bundled?: RendererHost } }).mikka
  if (!bridge?.bundled) throw new Error('desktop_preload_unavailable')
  return bridge.bundled
}
