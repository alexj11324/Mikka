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

/** Words a person adds to a name that say which of a family of repositories they mean ("Mikka site" → mikka-web). */
const QUALIFIERS = [
  ['site', 'web', 'website', 'www', 'homepage', 'landing', 'frontend', '网站', '官网', '前端'],
  ['app', 'application', 'client', '应用'],
  ['api', 'backend', 'server', '后端', '服务端'],
  ['docs', 'doc', 'documentation', '文档'],
]
const FILLER = new Set(['the', 'repo', 'repository', 'project', 'code', '仓库', '项目', '代码'])
const words = (name: string) => plain(name).split(/[-_. ]+/).filter(word => word && !FILLER.has(word))
const sameWord = (a: string, b: string) => a === b || QUALIFIERS.some(group => group.includes(a) && group.includes(b))

/**
 * A name of several words, the first naming the repository family and the rest qualifying it
 * ("Mikka site", "mikka web"): the repositories of that family whose own name carries every
 * qualifier, or one of its synonyms. A single word is never matched this way.
 */
export function matchRepositoryWords<T extends { fullName: string }>(name: string, repositories: readonly T[]): RepositoryMatch<T> {
  const [stem, ...qualifiers] = words(name)
  if (!stem || qualifiers.length === 0) return { kind: 'none' }
  const found = repositories.filter(repository => {
    const [first, ...rest] = words(repository.fullName.slice(repository.fullName.indexOf('/') + 1))
    return first === stem && qualifiers.every(qualifier => rest.some(word => sameWord(word, qualifier)))
  })
  if (found.length === 1) return { kind: 'one', repository: found[0]! }
  return found.length ? { kind: 'several', candidates: found } : { kind: 'none' }
}
