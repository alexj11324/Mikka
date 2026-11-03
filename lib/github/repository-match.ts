/** The Mikka GitHub App's page where a person picks which repositories it may reach. */
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/mikka-github/installations/new'

/** A repository named without its owner ("Mikka_test"): not owner/repo, not a URL or SSH address. */
export function isBareRepositoryName(repo: string) {
  const name = repo.trim()
  return name.length > 0 && name.length <= 100 && /^[A-Za-z0-9_. -]+$/.test(name) && /[A-Za-z0-9]/.test(name)
}

const plain = (name: string) => name.trim().replace(/\.git$/i, '').toLowerCase()
/** Case, `-`, `_`, `.` and spaces are not told apart: "Mikka_test", "mikka-test" and "MIKKA.TEST" are one name. */
const loose = (name: string) => plain(name).replace(/[-_. ]+/g, '')

export type RepositoryMatch<T extends { fullName: string }> =
  | { kind: 'one'; repository: T }
  | { kind: 'several'; candidates: T[] }
  | { kind: 'none' }

/** Matches the repository part of each owner/repo. A case-insensitive exact name wins over a loose one. */
export function matchRepositoryName<T extends { fullName: string }>(name: string, repositories: readonly T[]): RepositoryMatch<T> {
  const repoPart = (repository: T) => repository.fullName.slice(repository.fullName.indexOf('/') + 1)
  const wanted = plain(name)
  const exact = repositories.filter(repository => plain(repoPart(repository)) === wanted)
  const found = exact.length ? exact : loose(name) ? repositories.filter(repository => loose(repoPart(repository)) === loose(name)) : []
  if (found.length === 1) return { kind: 'one', repository: found[0]! }
  return found.length ? { kind: 'several', candidates: found } : { kind: 'none' }
}


/**
 * Every repository a person could mean by `name`: those whose own name contains it ("mikka" → alexj11324/Mikka,
 * mikka-web, mikka-enterprise); when none does, those containing its first word ("Mikka site" → mikka*).
 * Exact and loose matches come first. It only lists; telling them apart is the caller's.
 */
export function relatedRepositories<T extends { fullName: string }>(name: string, repositories: readonly T[]): T[] {
  const repoPart = (repository: T) => repository.fullName.slice(repository.fullName.indexOf('/') + 1)
  const containing = (word: string) => word ? repositories.filter(repository => loose(repoPart(repository)).includes(word)) : []
  const whole = containing(loose(name))
  const related = whole.length ? whole : containing(loose(plain(name).split(/[-_. ]+/).find(Boolean) ?? ''))
  const rank = (repository: T) => plain(repoPart(repository)) === plain(name) ? 0 : loose(repoPart(repository)) === loose(name) ? 1 : 2
  return related.map((repository, index) => ({ repository, index })).sort((a, b) => rank(a.repository) - rank(b.repository) || a.index - b.index).map(item => item.repository)
}
