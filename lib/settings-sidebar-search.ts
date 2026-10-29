/** Words a section answers to beyond its title, in any locale: what lives on
 * its page. Model subscriptions (ChatGPT / Claude and their quota) are on
 * Integrations for now; translated words come from `Settings.sections.<id>.keywords`. */
export const SETTINGS_SECTION_KEYWORDS: Partial<Record<string, readonly string[]>> = {
  integrations: ['model subscriptions', 'subscription', 'quota', 'usage', 'ChatGPT', 'OpenAI', 'Codex', 'Claude', 'Anthropic'],
}

/** Whether a settings sidebar item stays visible for the current search query. */
export function settingsItemVisible({ query, groupTitle, groupLabel, itemTitle, label, keywords: translated = '', section, routed }: {
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
  /** Translated search words for the item, space separated. */
  keywords?: string
  section?: string
  /** True on the routed /settings pages; Teams and Members only exist there. */
  routed: boolean
}) {
  const normalized = query.trim().toLowerCase()
  const keywords = (section && SETTINGS_SECTION_KEYWORDS[section]) || []
  const matches = `${groupTitle} ${groupLabel} ${itemTitle} ${label} ${translated} ${keywords.join(' ')}`.toLowerCase().includes(normalized)
  return matches && (routed || (section !== 'teams' && section !== 'members'))
}
