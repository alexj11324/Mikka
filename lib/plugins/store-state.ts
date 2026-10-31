// What the right side of a 插件 store item shows (decision 2026-10-31, as Codex):
// `…` once the person has connected the app (a menu to manage it), `+` while
// they have not (it starts the connect flow). Pure, so the rule is tested alone.

export type StoreItemState = 'connected' | 'add' | 'unavailable'

/**
 * - A Composio app is connected when the person has any account on it (an
 *   expired one too: they manage it from the menu). Without one it is `+`,
 *   unless connecting is not configured on this deployment.
 * - GitHub, Linear and Telegram follow their own state; `+` opens their page,
 *   where their own connect flow lives. Unknown state shows nothing yet.
 */
export function storeItemState(input:
  | { kind: 'composio'; accounts: number; canLink: boolean; loading: boolean }
  | { kind: 'own'; state: 'connected' | 'notConnected' | 'paused' | null | undefined },
): StoreItemState | null {
  if (input.kind === 'composio') {
    if (input.loading) return null
    if (input.accounts > 0) return 'connected'
    return input.canLink ? 'add' : 'unavailable'
  }
  if (input.state === 'connected') return 'connected'
  if (input.state === 'notConnected') return 'add'
  return input.state === 'paused' ? 'unavailable' : null
}

/** Store search: the app's name or slug, case-insensitive. */
export function matchesStoreQuery(app: { id: string; name: string }, query: string) {
  const needle = query.trim().toLowerCase()
  return !needle || app.name.toLowerCase().includes(needle) || app.id.includes(needle)
}
