import type { CommentAttachment, ThreadMessage, ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'

/**
 * One comment as the activity log draws it: the message itself plus the
 * replies that answer it, flattened into a tree the renderer walks. A reply
 * that names a message outside its own thread, or names a message that is no
 * longer there, hangs from the thread's first message instead of vanishing —
 * a written reply is never dropped because its parent moved.
 */
export type CommentNode = {
  message: ThreadMessage
  /** Depth from the thread's first message (0); the renderer indents by this. */
  depth: number
  replies: CommentNode[]
}

/**
 * A reply may only answer a message in its own thread, and only a message
 * that is still there. `replyTo` on a deleted parent is kept so the tombstone
 * still shows its replies.
 */
function answerable(messages: ThreadMessage[], id: string | undefined, self: string) {
  if (!id || id === self) return null
  return messages.some(message => message.id === id) ? id : null
}

/** The thread's messages as a reply tree, oldest first at every level. A
 * message whose `replyTo` points at itself or at nothing hangs from the root,
 * so a malformed record still renders every message exactly once. */
export function commentTree(thread: ThreadRecord): CommentNode[] {
  const messages = thread.messages.filter(message => typeof message?.id === 'string')
  const childrenOf = new Map<string | null, ThreadMessage[]>()
  for (const message of messages) {
    // Deleting a message before its replies were written would orphan them, so
    // a dangling target falls back to the root rather than dropping the reply.
    const target = answerable(messages, message.replyTo, message.id)
    const list = childrenOf.get(target)
    if (list) list.push(message)
    else childrenOf.set(target, [message])
  }
  const order = (a: ThreadMessage, b: ThreadMessage) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
  // A cycle (a → b → a) can never hang from the root; lift those to it.
  const seen = new Set<string>()
  const build = (parentId: string | null, depth: number): CommentNode[] => {
    const nodes: CommentNode[] = []
    for (const message of [...(childrenOf.get(parentId) ?? [])].sort(order)) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      nodes.push({ message, depth, replies: build(message.id, depth + 1) })
    }
    return nodes
  }
  const roots = build(null, 0)
  // Anything unreachable through the root (a pure cycle) still gets a row.
  for (const message of [...messages].sort(order)) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    roots.push({ message, depth: 0, replies: build(message.id, 1) })
  }
  return roots.sort((a, b) => order(a.message, b.message))
}

/** Every message in a thread once, in the order the tree draws them (parents before their replies). */
export function flattenComments(nodes: CommentNode[]): CommentNode[] {
  return nodes.flatMap(node => [node, ...flattenComments(node.replies)])
}

/** The messages a thread still shows: nobody counts a tombstone as a comment. */
export function liveMessages(thread: ThreadRecord) {
  return thread.messages.filter(message => !message.deletedAt)
}

/**
 * Whether a message may be edited or deleted by this viewer. The server's
 * authorship guard is the authority; this only decides whether to offer it, so
 * showing the control to the wrong person costs a refused write, never a
 * changed row. Messages from before MIK-17 carry no author id and belong to
 * nobody, so no one is offered the controls.
 */
export function mayEditMessage(message: ThreadMessage, viewerId: string | undefined) {
  if (!viewerId || !message.authorUserId) return false
  if (message.deletedAt) return false
  return message.authorUserId === viewerId
}

/** What a tombstone says: its author deleted it, and its replies stay below. */
export function isTombstone(message: ThreadMessage) {
  return Boolean(message.deletedAt)
}

/** A comment's files, minus any the record lost; the renderer needs a name to draw one. */
export function attachmentsOf(message: ThreadMessage): CommentAttachment[] {
  return (message.attachments ?? []).filter(
    file => typeof file?.id === 'string' && file.id.length > 0 && typeof file.name === 'string' && file.name.length > 0
  )
}

/** The thread's first message, which is the comment the thread exists for. */
export function rootMessage(thread: ThreadRecord) {
  return thread.messages[0] ?? null
}
