/** Whether a settings sidebar item stays visible for the current search query. */
export function settingsItemVisible({ query, groupTitle, groupLabel, itemTitle, label, section, routed }: {
  /** Raw search input. */
  query: string
  /** English group name (e.g. "Administration"). */
  groupTitle: string
  /** Translated group label. */
  groupLabel: string
  /** English item name (e.g. "Billing"). */
  itemTitle: string
  /** Translated item label. */
  label: string
  section?: string
  /** True on the routed /settings pages; Teams and Members only exist there. */
  routed: boolean
}) {
  const normalized = query.trim().toLowerCase()
  const matches = `${groupTitle} ${groupLabel} ${itemTitle} ${label}`.toLowerCase().includes(normalized)
  return matches && (routed || (section !== 'teams' && section !== 'members'))
}
