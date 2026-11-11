/** Credential-free selection for shared caches, live channels and assets. The
 * native builds never install a browser directory and keep their own transport. */
type Selection = { version: number; account: { server: string } | null }
let read: (() => Selection) | null = null
let readWorkspace: (() => string | null) | null = null
export function installWebSelection(source: () => Selection, workspace?: () => string | null) { read = source; readWorkspace = workspace ?? null }
export const selectedWebServer = () => read?.().account?.server ?? null
/** The selected server's confirmed Workspace (lib/workspace-selection.ts
 * header value), or null: the cloud cookie session or the server's default. */
export const selectedWebWorkspace = () => readWorkspace?.() ?? null
export const webSelectionVersion = () => read?.().version ?? 0

/** A self-hosted server may only issue a live capability for its own HTTPS
 * origin and base path. The cloud's separately configured gateway is unchanged. */
export function selectedLiveURLAllowed(value: string, server: string | null): boolean {
  try {
    const target = new URL(value)
    if (target.username || target.password || target.hash || !['ws:', 'wss:'].includes(target.protocol)) return false
    if (!server) return true
    const base = new URL(server)
    return target.protocol === 'wss:' && target.host === base.host
      && target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)
  } catch { return false }
}
