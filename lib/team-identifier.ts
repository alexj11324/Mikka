export function suggestTeamIdentifier(name: string, existingIdentifiers: readonly string[] = []) {
  if (!name.trim()) return ''
  const words = name.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().match(/[A-Z0-9]+/g) ?? []
  const letters = words.join('').replace(/^[0-9]+/, '')
  const initials = words.map(word => word[0]).join('').replace(/^[0-9]+/, '')
  let base = (words.length > 1 && initials.length > 1 ? initials : letters.slice(0, 3)).slice(0, 12) || 'TEAM'
  if (base.length === 1) base += '0'
  const used = new Set(existingIdentifiers.map(value => value.toUpperCase()))
  if (!used.has(base)) return base
  for (let index = 2; ; index++) {
    const suffix = String(index)
    const candidate = `${base.slice(0, 12 - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}
