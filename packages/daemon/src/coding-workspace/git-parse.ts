import type { GitChangeState, GitCommit } from '@mikka/protocol/coding-workspace-git'

/** Pure parsers for the bounded Git facts the daemon observes. Keeping them
 * free of filesystem/process code makes the exact porcelain and log contract
 * testable without a checkout. */
export type ParsedBranch = {
  headSha: string | null; branch: string | null; detached: boolean
  upstream: { remote: string; branch: string; ahead: number; behind: number } | null
}
export type ParsedStatusEntry = {
  path: string; previousPath: string | null
  index: GitChangeState | null; worktree: GitChangeState | null
  conflicted: boolean; untracked: boolean
}
export type ParsedStatus = { branch: ParsedBranch; entries: ParsedStatusEntry[] }

const state = (code: string): GitChangeState | null => {
  switch (code) {
    case '.': return null
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'type_changed'
    case 'U': return 'conflicted'
    default: return null
  }
}
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

function parseBranchField(field: string, branch: ParsedBranch) {
  if (field.startsWith('# branch.oid ')) {
    const value = field.slice('# branch.oid '.length)
    branch.headSha = oid.test(value) ? value : null
  } else if (field.startsWith('# branch.head ')) {
    const value = field.slice('# branch.head '.length)
    branch.detached = value === '(detached)'; branch.branch = branch.detached ? null : value
  } else if (field.startsWith('# branch.upstream ')) {
    const value = field.slice('# branch.upstream '.length)
    const slash = value.indexOf('/')
    if (slash > 0 && slash < value.length - 1)
      branch.upstream = { remote: value.slice(0, slash), branch: value.slice(slash + 1), ahead: 0, behind: 0 }
  } else if (field.startsWith('# branch.ab ')) {
    const match = /^\+(\d+) -(\d+)$/.exec(field.slice('# branch.ab '.length))
    if (match && branch.upstream) {
      branch.upstream.ahead = Number(match[1]); branch.upstream.behind = Number(match[2])
    }
  }
}

/** `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * Records are NUL-terminated; a rename/copy original path is the next field. */
/** `execa` returns a `Uint8Array` for `encoding: 'buffer'`, and its inherited
 * `toString()` joins the byte values ("49,32,77,...") instead of decoding
 * them, so every Git read must decode explicitly. */
export function gitText(bytes: Uint8Array | string): string {
  return typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
}

export function parsePorcelainV2(output: string): ParsedStatus {
  const fields = output.split('\0')
  const branch: ParsedBranch = { headSha: null, branch: null, detached: false, upstream: null }
  const entries: ParsedStatusEntry[] = []
  // An unexplained `status_parse` used to say nothing about what Git actually
  // printed, which made a repository-specific record impossible to identify.
  const unreadable = (field: string) => new Error(`status_parse: ${JSON.stringify(field.slice(0, 120))}`)
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field) continue
    if (field.startsWith('#')) { parseBranchField(field, branch); continue }
    if (field.startsWith('? ')) {
      entries.push({ path: field.slice(2), previousPath: null, index: null, worktree: null, conflicted: false, untracked: true })
      continue
    }
    // Ignored paths are never tracked, so they cannot appear in a restore plan.
    if (field.startsWith('! ')) continue
    if (field.startsWith('1 ')) {
      const match = /^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(field)
      if (!match) throw unreadable(field)
      entries.push({ path: match[3]!, previousPath: null, index: state(match[1]!), worktree: state(match[2]!), conflicted: false, untracked: false })
      continue
    }
    if (field.startsWith('2 ')) {
      const match = /^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(field)
      const previousPath = fields[index + 1]
      if (!match || previousPath === undefined) throw unreadable(field)
      index++
      entries.push({ path: match[3]!, previousPath, index: state(match[1]!), worktree: state(match[2]!), conflicted: false, untracked: false })
      continue
    }
    if (field.startsWith('u ')) {
      const match = /^u (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(field)
      if (!match) throw unreadable(field)
      entries.push({ path: match[3]!, previousPath: null, index: 'conflicted', worktree: 'conflicted', conflicted: true, untracked: false })
      continue
    }
    throw unreadable(field)
  }
  return { branch, entries: entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) }
}

// `git log -z` terminates every record with NUL and inserts nothing between
// records. Without it Git writes a newline before each record after the first,
// so the next SHA would parse as "\n<sha>". The format therefore must not carry
// its own trailing separator.
const commitFormat = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s'
export const gitLogFormat = commitFormat
/** The exact argv `parseGitLog` reads. Keeping it here lets a source-only test
 * prove `-z` is present instead of only proving the parser accepts its output. */
export function gitLogArgs(limit: number, offset: number) {
  return ['log', '-z', `--format=${commitFormat}`, '-n', String(limit), `--skip=${offset}`, '--no-decorate']
}

/** Each commit is seven NUL-terminated fields. Dates are normalized to UTC so
 * the strict ISO wire schema never depends on the device's timezone. */
export function parseGitLog(output: string, options: { headSha: string; baseSha: string | null }): GitCommit[] {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 7 !== 0) throw new Error('log_parse')
  const commits: GitCommit[] = []
  for (let offset = 0; offset < fields.length; offset += 7) {
    const [sha, parents, authorName, authorEmail, authoredAt, committedAt, subject] = fields.slice(offset, offset + 7)
    if (!sha || !oid.test(sha)) throw new Error('log_parse')
    const time = (value: string | undefined) => {
      const parsed = new Date(value ?? '')
      if (!Number.isFinite(parsed.getTime())) throw new Error('log_parse')
      return parsed.toISOString()
    }
    commits.push({ sha, parents: parents ? parents.split(' ').filter(Boolean) : [],
      authorName: (authorName ?? '').slice(0, 200), authorEmail: (authorEmail ?? '').slice(0, 320),
      authoredAt: time(authoredAt), committedAt: time(committedAt), subject: (subject ?? '').slice(0, 1000),
      head: sha === options.headSha, base: options.baseSha !== null && sha === options.baseSha })
  }
  return commits
}

export function parseHistoryCursor(cursor: string | undefined, headSha: string) {
  if (cursor === undefined) return 0
  const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?):([0-9]{1,8})$/.exec(cursor)
  if (!match || match[1] !== headSha) return null
  const offset = Number(match[2])
  return Number.isSafeInteger(offset) && offset <= 1_000_000 ? offset : null
}
export const historyCursor = (headSha: string, offset: number) => `${headSha}:${offset}`
