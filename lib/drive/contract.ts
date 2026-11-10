// The Drive file tree's pure contract: ids, paths, limits, the manifest digest
// and the change set a write carries. Kept free of I/O, of `server-only` and
// of zod so this module and its tests run as plain source (ALE-32, ALE-33).
//
// Drive is the tree of files a person, a project or a person inside a project
// owns. It is NOT a Git worktree and NOT the coding-workspace file view: those
// describe a repository a run checked out. A volume is the unit that holds one
// tree, and every write to it is a CAS on the tree's digest.

/**
 * A volume's primary key: `vol_` then a 26-character Crockford base32 ULID.
 *
 * The prefix makes an id self-describing wherever it appears (a log line, an
 * MCP call, a URL), which a bare uuid cannot do. Stored as `text`, because a
 * uuid column would reject the prefix.
 */
export const VOLUME_ID_PREFIX = 'vol_'
/** A version's primary key: `vver_` then a ULID. */
export const VOLUME_VERSION_ID_PREFIX = 'vver_'

const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/
export const VOLUME_ID = new RegExp(`^${VOLUME_ID_PREFIX}[0-9A-HJKMNP-TV-Z]{26}$`)
export const VOLUME_VERSION_ID = new RegExp(`^${VOLUME_VERSION_ID_PREFIX}[0-9A-HJKMNP-TV-Z]{26}$`)

export function isVolumeId(value: unknown): value is string {
  return typeof value === 'string' && VOLUME_ID.test(value)
}
export function isVolumeVersionId(value: unknown): value is string {
  return typeof value === 'string' && VOLUME_VERSION_ID.test(value)
}
/** Whether `value` is a well-formed ULID body (the 26 characters after a prefix). */
export function isUlidBody(value: unknown): value is string {
  return typeof value === 'string' && ULID_BODY.test(value)
}

/**
 * The three upper bounds, taken from Capy's Drive as shipped: a tree holds at
 * most 100 000 entries, a single file is at most 100 MiB, and a file's mode is
 * one of exactly two values. The file limit is the one the sandbox and the
 * upload path both enforce, so keep the two in step by importing this constant.
 */
export const DRIVE_MAX_ENTRIES = 100_000
export const DRIVE_MAX_FILE_BYTES = 100 * 1024 * 1024
/** The only two modes a Drive entry may carry: a regular file, or an executable one. */
export const DRIVE_FILE_MODES = [0o644, 0o755] as const
export type DriveFileMode = (typeof DRIVE_FILE_MODES)[number]

export function isDriveFileMode(value: unknown): value is DriveFileMode {
  return value === 0o644 || value === 0o755
}

/**
 * A path is relative, `/`-separated, and never empty, absolute, a Windows drive
 * letter, or carrying `.`/`..`/empty segments. It also refuses control
 * characters and backslashes, so one path means one path on every host.
 *
 * Deliberately NOT the coding-workspace path rule: that one additionally hides
 * `.env`, keys and credentials, because it exposes a checked-out repository's
 * secrets. Drive holds files the person chose to keep, so it keeps this module's
 * simpler rule and does its own access check instead.
 */
export const DRIVE_PATH_MAX_BYTES = 1024

export function isDrivePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > DRIVE_PATH_MAX_BYTES) return false
  // Reject before splitting: a control character can hide a path's real shape.
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * Why `path` cannot be a Drive entry, or null when it can. Returns a stable
 * code rather than a message: the caller decides the wording.
 */
export type DrivePathProblem = 'empty' | 'too_long' | 'not_relative' | 'forbidden_character' | 'bad_segment'
export function drivePathProblem(value: unknown): DrivePathProblem | null {
  if (typeof value !== 'string') return 'empty'
  if (!value) return 'empty'
  if (value.length > DRIVE_PATH_MAX_BYTES) return 'too_long'
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return 'forbidden_character'
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'not_relative'
  if (!value.split('/').every(part => part !== '' && part !== '.' && part !== '..')) return 'bad_segment'
  return null
}

/** One entry of a tree at a version: everything needed to fetch and restore it. */
export interface DriveManifestEntry {
  path: string
  mode: DriveFileMode
  sizeBytes: number
  sha256: string
}

const SHA256 = /^[a-f0-9]{64}$/
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/**
 * The canonical text a manifest digest is taken over: entries sorted by path,
 * each as `path\0mode\0size\0sha256\n`. Sorting makes the digest a property of
 * the tree, not of the order a client happened to list it in; the NUL
 * separators keep `a/b` + `c` distinct from `a` + `b/c`.
 *
 * This is the value `headDigest` holds and the value a CAS write compares.
 */
export function manifestCanonicalText(entries: readonly DriveManifestEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(entry => `${entry.path}\u0000${entry.mode}\u0000${entry.sizeBytes}\u0000${entry.sha256}\n`)
    .join('')
}

/**
 * The tree digest: sha256 over `manifestCanonicalText`. `sha256Hex` is passed in
 * so this module stays dependency-free; the store supplies node:crypto's.
 */
export function manifestDigest(entries: readonly DriveManifestEntry[], sha256Hex: (text: string) => string): string {
  return sha256Hex(manifestCanonicalText(entries))
}

/** Why a manifest is unacceptable, as a stable code, or null when it is fine. */
export type DriveManifestProblem =
  | 'too_many_entries' | 'path_invalid' | 'path_duplicate' | 'mode_invalid'
  | 'size_invalid' | 'file_too_large' | 'digest_invalid'

export function driveManifestProblem(entries: readonly DriveManifestEntry[]): DriveManifestProblem | null {
  if (entries.length > DRIVE_MAX_ENTRIES) return 'too_many_entries'
  const seen = new Set<string>()
  for (const entry of entries) {
    if (drivePathProblem(entry.path) !== null) return 'path_invalid'
    if (seen.has(entry.path)) return 'path_duplicate'
    seen.add(entry.path)
    if (!isDriveFileMode(entry.mode)) return 'mode_invalid'
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) return 'size_invalid'
    if (entry.sizeBytes > DRIVE_MAX_FILE_BYTES) return 'file_too_large'
    if (!isSha256(entry.sha256)) return 'digest_invalid'
  }
  return null
}

/**
 * One change in a write. `put` names the bytes by digest: the store looks the
 * blob up in the content-addressed table, so a client cannot make the tree
 * point at bytes the server never received and hashed.
 */
export type DriveChange =
  | { op: 'put'; path: string; mode: DriveFileMode; sha256: string; sizeBytes: number }
  | { op: 'delete'; path: string }

export interface DriveWrite {
  /** The digest the client believes is current. The write lands only if it still is. */
  expectedDigest: string | null
  changes: readonly DriveChange[]
  /**
   * The caller's idempotency key: the same id with the same body replays as
   * success without writing twice; the same id with a different body is refused.
   */
  mutationId: string
}

export type DriveChangeProblem =
  | 'no_changes' | 'too_many_changes' | 'path_invalid' | 'path_duplicate'
  | 'mode_invalid' | 'size_invalid' | 'file_too_large' | 'digest_invalid' | 'mutation_id_invalid'

export const DRIVE_MAX_CHANGES = 10_000
const MUTATION_ID = /^[A-Za-z0-9._:-]{8,128}$/

export function driveWriteProblem(write: DriveWrite): DriveChangeProblem | null {
  if (typeof write.mutationId !== 'string' || !MUTATION_ID.test(write.mutationId)) return 'mutation_id_invalid'
  if (!write.changes.length) return 'no_changes'
  if (write.changes.length > DRIVE_MAX_CHANGES) return 'too_many_changes'
  const seen = new Set<string>()
  for (const change of write.changes) {
    if (drivePathProblem(change.path) !== null) return 'path_invalid'
    if (seen.has(change.path)) return 'path_duplicate'
    seen.add(change.path)
    if (change.op === 'delete') continue
    if (change.op !== 'put') return 'no_changes'
    if (!isDriveFileMode(change.mode)) return 'mode_invalid'
    if (!Number.isSafeInteger(change.sizeBytes) || change.sizeBytes < 0) return 'size_invalid'
    if (change.sizeBytes > DRIVE_MAX_FILE_BYTES) return 'file_too_large'
    if (!isSha256(change.sha256)) return 'digest_invalid'
  }
  return null
}

/**
 * The tree a write produces, given the tree it starts from. Pure: it applies
 * the changes in order and returns a path-sorted manifest, so the caller can
 * compute the new digest before it has touched a row.
 *
 * `blobSize` is the size the store recorded for a digest. A write never takes
 * the client's word for it, so a put whose stated size disagrees is refused
 * here rather than stored wrong.
 */
export type DriveApplyProblem = 'blob_unknown' | 'blob_size_mismatch'

export function applyDriveChanges(
  current: readonly DriveManifestEntry[],
  changes: readonly DriveChange[],
  blobSize: (sha256: string) => number | undefined,
): { manifest: DriveManifestEntry[] } | { problem: DriveApplyProblem; path: string } {
  const byPath = new Map(current.map(entry => [entry.path, entry]))
  for (const change of changes) {
    if (change.op === 'delete') { byPath.delete(change.path); continue }
    const size = blobSize(change.sha256)
    if (size === undefined) return { problem: 'blob_unknown', path: change.path }
    if (size !== change.sizeBytes) return { problem: 'blob_size_mismatch', path: change.path }
    byPath.set(change.path, { path: change.path, mode: change.mode, sizeBytes: size, sha256: change.sha256 })
  }
  return { manifest: [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}

/** The paths a write names, for a conflict report: what the client should re-read. */
export function driveChangePaths(changes: readonly DriveChange[]): string[] {
  return [...new Set(changes.map(change => change.path))].sort()
}

/**
 * Which of the requested paths actually differ from the server's current tree.
 * A digest mismatch alone tells a client only that it lost the race; naming
 * the paths tells it what to re-read before it tries again.
 *
 * A path needs a re-read only when the server holds something the client's view
 * disagrees with: a put over an entry whose bytes or mode differ, or a delete of
 * a path that is still there. A create (the server has nothing at that path) and
 * a put that already matches ask for nothing, and a delete of an absent path
 * does too, so a retry after a partial read reports nothing rather than
 * everything.
 */
export function conflictedDrivePaths(
  current: readonly DriveManifestEntry[],
  changes: readonly DriveChange[],
): string[] {
  const byPath = new Map(current.map(entry => [entry.path, entry]))
  const conflicted: string[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.path)) continue
    seen.add(change.path)
    const held = byPath.get(change.path)
    if (!held) continue
    if (change.op === 'delete') { conflicted.push(change.path); continue }
    if (held.sha256 !== change.sha256 || held.mode !== change.mode) conflicted.push(change.path)
  }
  return conflicted.sort()
}

/**
 * The layers of Drive this repository starts with. Capy has six; Mikka starts
 * with three, and adds a layer only when a caller needs it.
 *
 * The name is `driveScope` and not `scope`: it is the layer a volume sits in,
 * not a Capy "scope" and not Mikka's tenant. `workspace` is deliberately absent
 * for the same reason — that word already means the tenant, and reusing it here
 * would make every later reader guess which one a column holds.
 */
export const DRIVE_SCOPES = ['user', 'project', 'project-user'] as const
export type DriveScope = (typeof DRIVE_SCOPES)[number]

export function isDriveScope(value: unknown): value is DriveScope {
  return typeof value === 'string' && (DRIVE_SCOPES as readonly string[]).includes(value)
}

/**
 * What a volume in `scope` is called and what it points at, checked before any
 * row is written. `project-user` names both the project and the person; the
 * other two name exactly one.
 */
export type DriveScopeProblem = 'scope_invalid' | 'scope_id_empty' | 'scope_user_required' | 'scope_user_unexpected'
export function driveScopeProblem(driveScope: unknown, scopeId: unknown, scopeUserId: unknown): DriveScopeProblem | null {
  if (!isDriveScope(driveScope)) return 'scope_invalid'
  if (typeof scopeId !== 'string' || !scopeId || scopeId.length > 200) return 'scope_id_empty'
  // An empty string is "no person", not a person named "": it would make the
  // unique key below collide with the project-wide volume.
  const hasUser = typeof scopeUserId === 'string' && scopeUserId.length > 0
  if (driveScope === 'project-user') return hasUser && scopeUserId.length <= 200 ? null : 'scope_user_required'
  return scopeUserId === null || scopeUserId === undefined ? null : 'scope_user_unexpected'
}
