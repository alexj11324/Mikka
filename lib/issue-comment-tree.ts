/**
 * The pure parts of a task's collaboration surface: how a flat comment list is
 * folded into the one level of nesting the page draws, and what a reference's
 * normal form is. No database, no session — the SQL and the access checks live in
 * lib/issue-collaboration.ts, which imports these.
 */

export type CommentRow = {
  id: string
  parentId: string | null
  createdAt: string
}

export type CommentNode<T extends CommentRow> = T & { replies: CommentNode<T>[] }

/**
 * Folds a flat list (oldest first) into threads: a top-level comment, then the
 * replies to it. A reply to a reply joins the same top-level thread instead of
 * indenting further, matching the template's one-level `comment: true` nesting.
 *
 * Two rules keep it honest when the data is odd:
 *  - a reply whose parent is not in this task (hard-deleted, or another task)
 *    is drawn at the top rather than dropped: losing someone's words is worse
 *    than showing them one level out;
 *  - a parent cycle cannot loop forever, because the walk up is bounded by the
 *    number of rows.
 */
export function foldComments<T extends CommentRow>(rows: readonly T[]): CommentNode<T>[] {
  const byId = new Map<string, CommentNode<T>>()
  for (const row of rows) byId.set(row.id, { ...row, replies: [] })
  const roots: CommentNode<T>[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (!row.parentId) { roots.push(node); continue }
    let thread = node
    for (let hops = 0; hops < rows.length && thread.parentId; hops++) {
      const parent = byId.get(thread.parentId)
      if (!parent) break
      thread = parent
    }
    if (thread.id === node.id) { roots.push(node); continue }
    thread.replies.push(node)
  }
  // Rows arrive oldest first and are appended in that order, so each thread's
  // replies read oldest first too; a stable sort keeps that if a caller did not.
  for (const root of roots) root.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return roots
}

/**
 * Schemes a stored reference must never carry: each one either executes in a
 * reader's page or reaches the local filesystem when the link is followed.
 * Everything else that is not http(s) is an identifier, not a URL.
 */
const REFUSED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about'])

/**
 * The form a reference is stored and compared in, so a pull URL and its bare
 * form unlink each other and a link added twice stays one row.
 *
 * Only a hierarchical URL (`scheme://…`) is treated as a URL, and only over
 * http(s). A provider identifier such as `linear:ABC-9`, a task code or a bare
 * hostname is an opaque reference, kept as typed but lowercased, because case in
 * an identifier is not a distinction anybody means. Anything whose scheme could
 * execute in a reader's page or read the local disk has no normal form and is
 * refused rather than stored.
 */
export function normalizeLinkTarget(ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme && REFUSED_SCHEMES.has(scheme)) return null
  // `scheme://` is how a link a person pasted begins; `linear:ABC-9` is not one.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.toLowerCase()
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return trimmed.toLowerCase() }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`.toLowerCase()
}
