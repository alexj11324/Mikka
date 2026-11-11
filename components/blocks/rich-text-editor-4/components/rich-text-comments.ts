import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { Extension, type Editor } from "@tiptap/core"
import {
  absolutePositionToRelativePosition,
  defaultDeleteFilter,
  defaultProtectedNodes,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap"
import { cn } from "cn"
import * as Y from "yjs"

import { useRichTextSelector } from "./rich-text-state"
import { COMMENT_MARK, THREADS_FIELD } from "./comment-mark"
export { CommentMark, COMMENT_MARK, THREADS_FIELD } from "./comment-mark"

/** Replies and resolves carry this origin, which the editor's undo skips. */
export const THREAD_ORIGIN = "threads"
/** A new thread's record; undo reverts it together with its anchor mark. */
export const THREAD_CREATE_ORIGIN = "thread-create"

/** A file a comment carries: bytes live in the issue's own attachment store, never in the thread record. */
export interface CommentAttachment {
  id: string
  name: string
  mediaType: string
  size: number
}

/** A message in a thread: the first is the comment, the rest are its replies. */
export interface ThreadMessage {
  id: string
  author: string
  authorUserId?: string
  body: string
  at: string
  /**
   * The message this one answers (a nested reply inside the same thread).
   * Absent on the thread's first message and on flat replies that answer the
   * thread itself; a reply always lives in the thread it answers.
   */
  replyTo?: string
  /** Last time the author changed `body`; absent while never edited. */
  editedAt?: string
  /**
   * Set when the author deleted the message. The row stays so its replies keep
   * their anchor and the author's choice remains visible as a tombstone.
   */
  deletedAt?: string
  /** Files posted with this message, in the order the author attached them. */
  attachments?: CommentAttachment[]
}

export interface ThreadRecord {
  id: string
  author: string
  createdAt: string
  resolved: boolean
  messages: ThreadMessage[]
}

export interface ThreadSeed {
  id: string
  author: string
  authorUserId?: string
  createdAt: string
  messages: Omit<ThreadMessage, "id">[]
}

// Open anchors read as a soft underline, the one under the caret as a fill; a
// teammate's selection over an anchor keeps its own hue.
export const RICH_TEXT_COMMENT_PROSE = cn(
  "[&_.tiptap_[data-comment]]:decoration-warning/70 [&_.tiptap_[data-comment]]:underline [&_.tiptap_[data-comment]]:decoration-2 [&_.tiptap_[data-comment]]:underline-offset-4",
  "[&_.tiptap_[data-comment=open]:not([data-peer-selection])]:bg-warning/10 dark:[&_.tiptap_[data-comment=open]:not([data-peer-selection])]:bg-warning/15",
  "[&_.tiptap_[data-comment=active]:not([data-peer-selection])]:bg-warning/25 dark:[&_.tiptap_[data-comment=active]:not([data-peer-selection])]:bg-warning/30"
)

export interface CommentAnchor {
  id: string
  excerpt: string
}

interface AnchorRange extends CommentAnchor {
  from: number
  to: number
}

function commentId(node: ProseMirrorNode | null | undefined) {
  const mark = node?.marks.find((item) => item.type.name === COMMENT_MARK)
  return typeof mark?.attrs.id === "string" ? mark.attrs.id : null
}

/** Every anchor in document order; a run split by bold still reads as one. */
export function readAnchorRanges(doc: ProseMirrorNode) {
  const anchors = new Map<string, AnchorRange>()
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const id = commentId(node)
    if (!id) return
    const hit = anchors.get(id)
    if (hit) {
      hit.to = pos + node.nodeSize
      hit.excerpt += node.text ?? ""
    } else {
      anchors.set(id, {
        id,
        excerpt: node.text ?? "",
        from: pos,
        to: pos + node.nodeSize,
      })
    }
  })
  return [...anchors.values()]
}

/** The thread under the caret, including at either edge of its anchor. */
export function readActiveComment(state: EditorState) {
  const { $from } = state.selection
  return commentId($from.nodeAfter) ?? commentId($from.nodeBefore)
}

/** True when an open thread anchors any character in the range. */
export function coversOpenComment(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  isOpen: (id: string) => boolean
) {
  let covered = false
  doc.nodesBetween(from, to, (node) => {
    const id = node.isText ? commentId(node) : null
    if (id && isOpen(id)) covered = true
    return !covered
  })
  return covered
}

/** A new thread may not cover an open thread's text; a resolved one yields. */
export function canAnchorComment(
  editor: Editor | null,
  isOpen: (id: string) => boolean
) {
  if (!editor?.isEditable) return false
  const { state } = editor
  const { from, to, empty } = state.selection
  if (empty || !editor.can().setMark(COMMENT_MARK)) return false
  if (!state.doc.textBetween(from, to).trim()) return false
  return !coversOpenComment(state.doc, from, to, isOpen)
}

const COMMENT_PAINT_KEY = new PluginKey<DecorationSet>("commentPaint")

function paint(state: EditorState, isOpen: (id: string) => boolean) {
  const active = readActiveComment(state)
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText) return
    const id = commentId(node)
    if (!id || !isOpen(id)) return
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        "data-comment": id === active ? "active" : "open",
      })
    )
  })
  return DecorationSet.create(state.doc, decorations)
}

interface CommentPaintOptions {
  /** Resolved threads keep their mark but lose their paint. */
  isOpen: (id: string) => boolean
}

export const CommentPaint = Extension.create<CommentPaintOptions>({
  name: "commentPaint",
  addOptions() {
    return { isOpen: () => true }
  },
  addProseMirrorPlugins() {
    const { isOpen } = this.options
    return [
      new Plugin<DecorationSet>({
        key: COMMENT_PAINT_KEY,
        state: {
          init: (_, state) => paint(state, isOpen),
          apply: (tr, previous, _, next) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(COMMENT_PAINT_KEY)
              ? paint(next, isOpen)
              : previous,
        },
        props: {
          decorations: (state) => COMMENT_PAINT_KEY.getState(state),
        },
      }),
    ]
  },
})

/** Re-reads isOpen after a thread resolves or reopens on any client.
 * Content edits already repaint in the plugin. A second transaction from a
 * Yjs update crashes Enter, Backspace and Delete, so failures stay local. */
export function repaintComments(editor: Editor) {
  if (editor.isDestroyed) return
  try {
    const view = editor.view
    if (view.isDestroyed) return
    view.dispatch(view.state.tr.setMeta(COMMENT_PAINT_KEY, true))
  } catch {
    // Decorations can wait for the next edit. Letting this escape blanks the page.
  }
}

/** Paints again when thread records change and the document itself does not. */
export function bindThreadRepaint(editor: Editor, subscribe: (onStoreChange: () => void) => () => void) {
  let cancelled = false
  const stop = subscribe(() => {
    queueMicrotask(() => {
      if (!cancelled) repaintComments(editor)
    })
  })
  return () => {
    cancelled = true
    stop()
  }
}

interface CommentShortcutOptions {
  isOpen: (id: string) => boolean
  onComment: () => void
}

/** Mod-Alt-M opens a comment on the selection, as in most document editors. */
export const CommentShortcut = Extension.create<CommentShortcutOptions>({
  name: "commentShortcut",
  addOptions() {
    return { isOpen: () => true, onComment: () => {} }
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-m": () => {
        if (!canAnchorComment(this.editor, this.options.isOpen)) return false
        this.options.onComment()
        return true
      },
    }
  },
})

function readCommentView(editor: Editor | null) {
  if (!editor) return { anchors: [] as CommentAnchor[], activeId: null }
  return {
    // Ids and text only: a teammate typing elsewhere shifts positions, and
    // that must not re-render the margin.
    anchors: readAnchorRanges(editor.state.doc).map(({ id, excerpt }) => ({
      id,
      excerpt,
    })),
    activeId: readActiveComment(editor.state),
  }
}

export function useCommentAnchors(editor: Editor | null) {
  return useRichTextSelector(editor, readCommentView)
}

/** Absolute range to Yjs positions, which survive a teammate's edits. */
export function toRelativeRange(editor: Editor, from: number, to: number) {
  const sync = ySyncPluginKey.getState(editor.state)
  if (!sync?.binding) return null
  const { mapping } = sync.binding
  return {
    from: absolutePositionToRelativePosition(from, sync.type, mapping),
    to: absolutePositionToRelativePosition(to, sync.type, mapping),
  }
}

export function toAbsolute(editor: Editor, position: Y.RelativePosition) {
  const sync = ySyncPluginKey.getState(editor.state)
  if (!sync?.binding) return null
  return relativePositionToAbsolutePosition(
    sync.doc,
    sync.type,
    position,
    sync.binding.mapping
  )
}

const undoManagers = new WeakMap<Y.Doc, Y.UndoManager>()

/** Collaboration's undo, widened to new threads: undoing a comment removes its
 * record with its anchor. One per doc; replies and resolves stay out of it. */
export function getCommentUndoManager(doc: Y.Doc, field: string) {
  let manager = undoManagers.get(doc)
  if (!manager) {
    manager = new Y.UndoManager([doc.getXmlFragment(field), threadMap(doc)], {
      trackedOrigins: new Set([ySyncPluginKey, THREAD_CREATE_ORIGIN]),
      deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
    })
    undoManagers.set(doc, manager)
  }
  return manager
}

/* Threads: one Y.Map per thread, keyed by id, in the doc's "threads" field. */

function threadMap(doc: Y.Doc) {
  return doc.getMap<Y.Map<unknown>>(THREADS_FIELD)
}

function createThread(seed: ThreadSeed) {
  const thread = new Y.Map<unknown>()
  thread.set("id", seed.id)
  thread.set("author", seed.author)
  if (seed.authorUserId) thread.set("authorUserId", seed.authorUserId)
  thread.set("createdAt", seed.createdAt)
  thread.set("resolved", false)
  const messages = new Y.Array<ThreadMessage>()
  messages.push(
    seed.messages.map((message, index) => ({
      id: `${seed.id}-${index + 1}`,
      ...message,
    }))
  )
  thread.set("messages", messages)
  return thread
}

/** Writes the seed threads; run once, on the seed document only. */
export function seedThreads(doc: Y.Doc, seeds: ThreadSeed[]) {
  const threads = threadMap(doc)
  for (const seed of seeds) threads.set(seed.id, createThread(seed))
}

/** Adds a thread record; the caller marks its anchor in the same breath. */
export function addThread(doc: Y.Doc, seed: ThreadSeed, origin: unknown) {
  doc.transact(() => threadMap(doc).set(seed.id, createThread(seed)), origin)
}

export function replyToThread(
  doc: Y.Doc,
  id: string,
  message: Omit<ThreadMessage, "id">,
  origin: unknown = THREAD_ORIGIN
) {
  const messages = threadMap(doc).get(id)?.get("messages")
  if (!(messages instanceof Y.Array)) return false
  // The writer's client id keeps two replies sent apart (offline) distinct.
  const messageId = `${id}-${doc.clientID}-${messages.length + 1}`
  doc.transact(() => messages.push([{ id: messageId, ...message }]), origin)
  return true
}

/**
 * Rewrites one message's body, stamping `editedAt`. The authorship guard in
 * `bindCommentAuthorship` refuses this for anyone but the message's author, so
 * the writer only has to name the message; `at` stays the original time.
 */
export function editThreadMessage(
  doc: Y.Doc,
  threadId: string,
  messageId: string,
  body: string,
  editedAt: string = new Date().toISOString()
) {
  const messages = threadMap(doc).get(threadId)?.get("messages")
  if (!(messages instanceof Y.Array)) return false
  const list = messages.toArray() as ThreadMessage[]
  const index = list.findIndex((message) => message?.id === messageId)
  if (index < 0 || list[index]?.deletedAt) return false
  const next = { ...list[index], body, editedAt }
  doc.transact(() => {
    messages.delete(index, 1)
    messages.insert(index, [next])
  }, THREAD_ORIGIN)
  return true
}

/**
 * Deletes one message. A message with replies becomes a tombstone so the
 * replies keep the message they answer; the last message left in a thread
 * without replies is removed outright. The authorship guard refuses this for
 * anyone but the message's author.
 */
export function deleteThreadMessage(
  doc: Y.Doc,
  threadId: string,
  messageId: string,
  deletedAt: string = new Date().toISOString()
) {
  const messages = threadMap(doc).get(threadId)?.get("messages")
  if (!(messages instanceof Y.Array)) return false
  const list = messages.toArray() as ThreadMessage[]
  const index = list.findIndex((message) => message?.id === messageId)
  if (index < 0) return false
  const answered = list.some((message) => message?.replyTo === messageId && !message?.deletedAt)
  if (!answered && list.length === 1) {
    doc.transact(() => messages.delete(0, messages.length), THREAD_ORIGIN)
    return true
  }
  // Replies keep a body-less row to hang from; the body is dropped, not hidden.
  const next = { ...list[index], body: "", attachments: [], deletedAt }
  doc.transact(() => {
    messages.delete(index, 1)
    messages.insert(index, [next])
  }, THREAD_ORIGIN)
  return true
}

export function setThreadResolved(doc: Y.Doc, id: string, resolved: boolean) {
  const thread = threadMap(doc).get(id)
  if (!thread) return false
  doc.transact(() => thread.set("resolved", resolved), THREAD_ORIGIN)
  return true
}

export type ThreadIndex = Record<string, ThreadRecord>

/** A stable snapshot for useSyncExternalStore: a new object only on change. */
export function createThreadStore(doc: Y.Doc) {
  const map = threadMap(doc)
  const listeners = new Set<() => void>()
  let snapshot = map.toJSON() as ThreadIndex

  function onChange() {
    snapshot = map.toJSON() as ThreadIndex
    listeners.forEach((listener) => listener())
  }

  map.observeDeep(onChange)
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    isOpen: (id: string) => snapshot[id]?.resolved === false,
    destroy: () => map.unobserveDeep(onChange),
  }
}

export type ThreadStore = ReturnType<typeof createThreadStore>
