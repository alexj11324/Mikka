/**
 * The URL slug suggested for a workspace name. A name with fewer than three
 * Latin letters or digits (a Chinese name, 「QA 第二工作区」) keeps what Latin
 * text it has, or `ws`, plus `suffix`, so the suggestion is always usable.
 */
export function workspaceSlug(name: string, suffix: string) {
  const latin = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
  if (latin.length >= 3 || !name.trim()) return latin
  return `${latin || 'ws'}-${suffix}`
}

/** Five base36 characters, drawn once per form so the suggestion does not change while typing. */
export function workspaceSlugSuffix() {
  return Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, '0')
}
