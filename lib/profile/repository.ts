// The one folded form of a repository's name, so a fact learnt from a GitHub
// event (which names `owner/repo`) and a chat's used repositories (which come
// from a remote URL) compare as the same string. Kept free of imports so the
// 记忆 page, the extraction path and the prompt builder can all read it.

/**
 * `owner/repo` for a github.com remote, however it is spelled: an HTTPS or SSH
 * URL, with or without `.git`, or already `owner/repo`. Anything else keeps its
 * trimmed form (a different host's remote is still a work context), and an
 * empty value folds to null: no fact can be scoped to nothing.
 */
export function foldRepository(remote: string | null | undefined): string | null {
  const value = (remote ?? '').trim()
  if (!value) return null
  const full = value.replace(/\.git$/i, '').replace(/\/+$/, '')
    .replace(/^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]/i, '')
  return full.toLowerCase() || null
}

/**
 * Whether a fact's repository applies to a chat working in `used`. A fact with
 * no repository is about the person themselves and always applies.
 */
export function repositoryApplies(fact: string | null | undefined, used: Iterable<string | null | undefined>): boolean {
  const scope = foldRepository(fact)
  if (!scope) return true
  for (const candidate of used) if (foldRepository(candidate) === scope) return true
  return false
}
