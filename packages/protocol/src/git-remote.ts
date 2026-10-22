// A git remote URL as the project it names (ADR 0026: a repo on a device is
// shown by what it is, not only by its folder). Pure, so desktop, phone and
// server read a remote the same way.

export interface GitRemote {
  /** "github.com", "gitlab.com", a self-hosted host... lowercased. */
  host: string
  /** Everything before the repo name: a user, org or group path. */
  owner: string
  name: string
  /** The page of the project in a browser. */
  webUrl: string
  /** `owner/name` on GitHub; the pull-request integration only knows these. */
  isGitHub: boolean
}

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

/**
 * Parses `https://host/o/r(.git)`, `ssh://git@host[:port]/o/r.git` and the
 * scp-like `git@host:o/r.git`. Null for anything else (a local path, a
 * remote with no owner).
 */
export function parseGitRemote(
  url: string | null | undefined
): GitRemote | null {
  const raw = url?.trim()
  if (!raw) return null
  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (!parsed.hostname || parsed.protocol === "file:") return null
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  } else {
    const match = SCP_LIKE.exec(raw)
    if (!match || /^[A-Za-z]$/.test(match[1]!)) return null // C:\ paths
    host = match[1]!
    path = match[2]!
  }
  const segments = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean)
  const name = segments.pop()
  if (!name || segments.length === 0) return null
  const lower = host.toLowerCase()
  const owner = segments.join("/")
  return {
    host: lower,
    owner,
    name,
    webUrl: `https://${lower}/${owner}/${name}`,
    isGitHub: lower === "github.com",
  }
}

/**
 * The remote with any credential removed (`https://user:token@host/...`), so
 * a token pasted into a remote never reaches the server or other devices.
 *
 * Two shapes have to come out clean, and the pattern has to fail *closed*:
 *
 * - The userinfo runs to the LAST `@`, which is what git and curl read.
 *   Matching only the first one leaves `https://@user:token@host/o/r` — a URL
 *   whose userinfo is empty and whose host then reads as `user:token@host` —
 *   with the token still in it.
 * - The run stops at `/` and at whitespace, and at nothing else. Stopping at
 *   `?` or `#` too would make a credential containing one of them
 *   (`https://me:hunter2#1@host/o/r`) match nothing at all, and an unmatched
 *   URL comes back unchanged, which is the wrong way to fail.
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i,
    (m, scheme: string) =>
      /^ssh:/i.test(scheme) && !m.slice(scheme.length).includes(":")
        ? m
        : scheme
  )
}

/**
 * One repository's identity, the same for every URL form git accepts:
 * `github.com/acme/app` for `git@github.com:acme/app.git`, the https clone
 * URL, and anything else that names the same project. Null for a remote that
 * names no repository (a local path), which has no rules of its own.
 *
 * Review rules are keyed by this (ADR ORV-172), so a repo keeps its rule when a
 * device re-clones it over another protocol.
 */
export function repoIdentity(url: string | null | undefined): string | null {
  const remote = parseGitRemote(url)
  return remote
    ? `${remote.host}/${remote.owner}/${remote.name}`.toLowerCase()
    : null
}

/**
 * A stored repository key: an identity this module produced, or a URL that
 * resolves to one. Null when the value names no repository, which is what a
 * settings write refuses rather than storing a key no lookup can match.
 */
export function normalizeRepoKey(
  value: string | null | undefined
): string | null {
  const raw = value?.trim()
  if (!raw) return null
  const identity = repoIdentity(raw)
  if (identity) return identity
  // Already `host/owner/name` (the shape `repoIdentity` returns).
  const parts = raw.replace(/^\/+|\/+$/g, "").split("/")
  return parts.length === 3 && parts.every(Boolean)
    ? parts.join("/").toLowerCase()
    : null
}
