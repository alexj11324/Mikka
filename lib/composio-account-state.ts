/** A toolkit may have several accounts. One enabled, usable account makes its row usable. */
type AccountState = { status: string; enabled?: boolean }
export type ToolkitState = 'active' | 'paused' | 'needsReconnect' | 'unknown'

export const needsReconnect = (account: AccountState) => account.status !== 'ACTIVE'

export function appState<T extends AccountState>(accounts: readonly T[]) {
  const usable = accounts.filter(account => !needsReconnect(account))
  const expired = accounts.length > 0 && usable.length === 0
  const on = usable.some(account => account.enabled)
  return { usable, expired, on, off: accounts.length > 0 && !expired && !on }
}

export function toolkitAccountStates<T extends AccountState & { toolkit: string }>(accounts: readonly T[]): Record<string, ToolkitState> {
  const groups = new Map<string, T[]>()
  for (const account of accounts) {
    const group = groups.get(account.toolkit)
    if (group) group.push(account)
    else groups.set(account.toolkit, [account])
  }
  const states: Record<string, ToolkitState> = {}
  for (const [toolkit, group] of groups) {
    const { expired, on, usable } = appState(group)
    // Older native DTOs could omit the switch. Missing status must not imply a pause.
    if (expired) states[toolkit] = 'needsReconnect'
    else if (on) states[toolkit] = 'active'
    else states[toolkit] = usable.some(account => account.enabled === undefined) ? 'unknown' : 'paused'
  }
  return states
}
