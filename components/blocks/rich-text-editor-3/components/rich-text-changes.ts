import type { Attributes, CommandProps } from "@tiptap/core"
import { isHistoryTransaction } from "@tiptap/pm/history"
import {
  Fragment,
  Slice,
  type MarkType,
  type NodeType,
  type Mark as ProseMirrorMark,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import { Mapping, ReplaceStep } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { Extension, Mark, type Editor } from "@tiptap/react"
import { cn } from "cn"

import { useRichTextSelector } from "./rich-text-state"

/** Tints for every ins/del below, shared by the document and the review rows;
 * the underline and strike carry the meaning without colour. */
export const SUGGESTION_TINTS = cn(
  "[&_ins]:bg-success/10 [&_ins]:text-success-foreground [&_ins]:decoration-success/60 [&_ins]:underline dark:[&_ins]:bg-success/15 dark:[&_ins]:text-success",
  "[&_del]:bg-destructive/10 [&_del]:text-destructive-foreground [&_del]:decoration-destructive/60 [&_del]:line-through dark:[&_del]:bg-destructive/15 dark:[&_del]:text-destructive"
)

/** The document's suggestion styling: the shared tints plus the active change. */
export const RICH_TEXT_CHANGES_PROSE = cn(
  SUGGESTION_TINTS,
  "[&_.tiptap_ins]:underline-offset-4",
  "[&_.tiptap_ins_[data-suggestion-active]]:bg-success/20 [&_.tiptap_del_[data-suggestion-active]]:bg-destructive/20 dark:[&_.tiptap_ins_[data-suggestion-active]]:bg-success/30 dark:[&_.tiptap_del_[data-suggestion-active]]:bg-destructive/30"
)

export type RichTextMarkupView = "all" | "final" | "original"

/** Read-only previews: Final drops deletions, Original drops insertions. All
 * markup opens a hairline between a replace's old and new words; visual only. */
export const RICH_TEXT_MARKUP_VIEW: Record<RichTextMarkupView, string> = {
  all: "[&_.tiptap_del+ins]:ms-1",
  final: cn(
    "[&_.tiptap_[data-suggestion-block~=delete]]:hidden [&_.tiptap_del]:hidden",
    "[&_.tiptap_ins]:bg-transparent! [&_.tiptap_ins]:text-inherit! [&_.tiptap_ins]:no-underline! [&_.tiptap_[data-suggestion-active]]:bg-transparent!"
  ),
  original: cn(
    "[&_.tiptap_[data-suggestion-block~=insert]]:hidden [&_.tiptap_ins]:hidden",
    "[&_.tiptap_del]:bg-transparent! [&_.tiptap_del]:text-inherit! [&_.tiptap_del]:no-underline! [&_.tiptap_[data-suggestion-active]]:bg-transparent!"
  ),
}

export const SUGGESTION_INSERT = "suggestionInsert"
export const SUGGESTION_DELETE = "suggestionDelete"

/** Meta flag: the transaction applies as is and is never tracked. */
export const SUGGESTION_SKIP = "richTextChangesSkip"

export type SuggestionKind = "insert" | "delete" | "replace"

export type SuggestionResolution = "accept" | "reject"

export interface SuggestionAttrs {
  id: string
  /** Author id; the block maps it to a person. */
  author: string
  /** ISO time of the first edit in the suggestion. */
  time: string | null
}

/** A change as a list shows it: no positions, so edits elsewhere never alter it. */
export interface SuggestionSummary extends SuggestionAttrs {
  kind: SuggestionKind
  inserted: string
  deleted: string
}

export interface SuggestionChange extends SuggestionSummary {
  /** Range from the first to the last marked position. */
  from: number
  to: number
}

export interface SuggestionTracking {
  tracking: boolean
  author: string
}

export interface SuggestionPluginOptions {
  /** Read on every transaction, so a mode switch needs no plugin swap. */
  getTracking: () => SuggestionTracking
  /** Stamps new suggestions; without it they carry no time. */
  now?: () => string | null
  createId?: () => string
}

interface Segment {
  kind: "insert" | "delete"
  mark: ProseMirrorMark
  from: number
  to: number
  text: string
  /** The textblock holding the text; a new block joins with a line break. */
  block: ProseMirrorNode | null
}

interface SuggestionPluginState {
  segments: Segment[]
  changes: SuggestionChange[]
  activeId: string | null
  decorations: DecorationSet
}

interface SuggestionTypes {
  insert: MarkType
  delete: MarkType
}

/** One recorded replace step, positioned in the final document. */
interface TrackedOp {
  deleted: Slice | null
  /** The node the deleted slice was cut from; a flat slice has inline top. */
  parent: NodeType
  at: number
  insert: { from: number; to: number } | null
  /** Step range in the state before the batch, when it is the first step. */
  before: { from: number; to: number } | null
  composing: boolean
}

export const suggestionPluginKey = new PluginKey<SuggestionPluginState>(
  "richTextChanges"
)

let sequence = 0

export function createSuggestionId() {
  sequence += 1
  return `s${Date.now().toString(36)}${sequence.toString(36)}`
}

function typesOf(schema: Schema): SuggestionTypes | null {
  const insert = schema.marks[SUGGESTION_INSERT]
  const remove = schema.marks[SUGGESTION_DELETE]
  return insert && remove ? { insert, delete: remove } : null
}

function attrsOf(mark: ProseMirrorMark): SuggestionAttrs {
  const { id, author, time } = mark.attrs
  return {
    id: String(id),
    author: typeof author === "string" ? author : "",
    time: typeof time === "string" ? time : null,
  }
}

function inlineText(node: ProseMirrorNode) {
  return node.isText
    ? (node.text ?? "")
    : (node.type.spec.leafText?.(node) ?? "")
}

function hasInline(fragment: Fragment) {
  let found = false
  fragment.descendants((node) => {
    if (found) return false
    if (node.isInline) found = true
    return !found
  })
  return found
}

function fragmentText(fragment: Fragment) {
  return fragment.textBetween(0, fragment.size, "\n", "\ufffc")
}

// Any leaf between two segments (text, atom, rule) keeps them apart.
function hasLeafBetween(doc: ProseMirrorNode, from: number, to: number) {
  if (from >= to) return false
  let found = false
  doc.nodesBetween(from, to, (node) => {
    if (found) return false
    if (node.isLeaf) found = true
    return !found
  })
  return found
}

function collectSegments(doc: ProseMirrorNode): Segment[] {
  const segments: Segment[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isInline) return true
    for (const mark of node.marks) {
      const kind =
        mark.type.name === SUGGESTION_INSERT
          ? "insert"
          : mark.type.name === SUGGESTION_DELETE
            ? "delete"
            : null
      if (!kind || mark.attrs.id == null) continue
      // A node carries at most one mark of each kind, so look two back.
      const open = segments
        .slice(-2)
        .find((segment) => segment.to === pos && segment.mark.eq(mark))
      if (open && open.block === parent) {
        open.to = pos + node.nodeSize
        open.text += inlineText(node)
      } else {
        segments.push({
          kind,
          mark,
          from: pos,
          to: pos + node.nodeSize,
          text: inlineText(node),
          block: parent,
        })
      }
    }
    return false
  })
  return segments
}

function changesFromSegments(segments: readonly Segment[]) {
  const changes = new Map<string, SuggestionChange>()
  const lastBlock = new Map<string, ProseMirrorNode | null>()
  for (const segment of segments) {
    const attrs = attrsOf(segment.mark)
    const change = changes.get(attrs.id) ?? {
      ...attrs,
      kind: segment.kind,
      inserted: "",
      deleted: "",
      from: segment.from,
      to: segment.to,
    }
    const field = segment.kind === "insert" ? "inserted" : "deleted"
    const key = `${attrs.id}:${segment.kind}`
    const joiner =
      change[field] && lastBlock.get(key) !== segment.block ? "\n" : ""
    change[field] += joiner + segment.text
    lastBlock.set(key, segment.block)
    change.from = Math.min(change.from, segment.from)
    change.to = Math.max(change.to, segment.to)
    if (change.kind !== segment.kind) change.kind = "replace"
    changes.set(attrs.id, change)
  }
  return [...changes.values()]
}

/** Suggestions grouped by id, in document order; replace = deletion plus insertion. */
export function readChanges(doc: ProseMirrorNode): SuggestionChange[] {
  return changesFromSegments(collectSegments(doc))
}

/** The change under the caret, or the first one a range selection touches. */
export function findChangeAt(
  changes: readonly SuggestionChange[],
  from: number,
  to = from
): string | null {
  let best: SuggestionChange | null = null
  let bestRank = Infinity
  for (const change of changes) {
    const hit =
      from === to
        ? change.from <= from && from <= change.to
        : change.from < to && change.to > from
    if (!hit) continue
    // A change that merely ends at the caret loses to one that holds it.
    const rank =
      (from === to && change.to === from ? 1e9 : 0) + change.to - change.from
    if (rank < bestRank) {
      best = change
      bestRank = rank
    }
  }
  return best?.id ?? null
}

function blockKinds(node: ProseMirrorNode, types: SuggestionTypes) {
  if (node.childCount === 0) return null
  let inserted = true
  let deleted = true
  node.forEach((child) => {
    if (!types.insert.isInSet(child.marks)) inserted = false
    if (!types.delete.isInSet(child.marks)) deleted = false
  })
  const kinds = [inserted ? "insert" : "", deleted ? "delete" : ""]
  return kinds.filter(Boolean).join(" ") || null
}

function buildDecorations(
  doc: ProseMirrorNode,
  segments: readonly Segment[],
  activeId: string | null
) {
  const types = typesOf(doc.type.schema)
  if (!types) return DecorationSet.empty
  const decorations: Decoration[] = []
  for (const segment of segments) {
    if (segment.mark.attrs.id !== activeId) continue
    decorations.push(
      Decoration.inline(segment.from, segment.to, {
        "data-suggestion-active": "true",
      })
    )
  }
  // Whole-block flags let Final and Original previews hide emptied paragraphs.
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const kinds = blockKinds(node, types)
    if (kinds) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          "data-suggestion-block": kinds,
        })
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

function buildPluginState(state: EditorState): SuggestionPluginState {
  const segments = collectSegments(state.doc)
  const changes = changesFromSegments(segments)
  const { from, to } = state.selection
  const activeId = findChangeAt(changes, from, to)
  return {
    segments,
    changes,
    activeId,
    decorations: buildDecorations(state.doc, segments, activeId),
  }
}

function isSkipped(tr: Transaction) {
  return (
    tr.getMeta(SUGGESTION_SKIP) === true ||
    tr.getMeta(suggestionPluginKey) != null ||
    isHistoryTransaction(tr) ||
    // Remote and programmatic steps opt out of history; they stay untracked.
    tr.getMeta("addToHistory") === false ||
    // Other plugins' normalizing transactions (trailing node, paste rules).
    tr.getMeta("appendedTransaction") != null
  )
}

function collectOps(
  transactions: readonly Transaction[],
  oldState: EditorState
): TrackedOp[] {
  const ops: TrackedOp[] = []
  transactions.forEach((tr, t) => {
    if (isSkipped(tr)) return
    const composing = tr.getMeta("composition") != null
    tr.steps.forEach((step, i) => {
      if (!(step instanceof ReplaceStep)) return
      const before = tr.docs[i]
      const deleted =
        step.from < step.to ? before.slice(step.from, step.to) : Slice.empty
      const removesText = hasInline(deleted.content)
      const addsText = hasInline(step.slice.content)
      if (!removesText && !addsText) return
      // Same text out and in is a structural move (a join), not an edit.
      if (
        removesText &&
        addsText &&
        fragmentText(deleted.content) === fragmentText(step.slice.content)
      ) {
        return
      }
      const rest = new Mapping()
      tr.mapping.maps.slice(i + 1).forEach((map) => rest.appendMap(map))
      transactions
        .slice(t + 1)
        .forEach((later) => rest.appendMapping(later.mapping))
      const $from = before.resolve(step.from)
      const insertFrom = rest.map(step.from, 1)
      const insertTo = rest.map(step.from + step.slice.size, -1)
      ops.push({
        deleted: removesText ? deleted : null,
        parent: $from.node($from.sharedDepth(step.to)).type,
        at: rest.map(step.from, -1),
        insert:
          addsText && insertFrom < insertTo
            ? { from: insertFrom, to: insertTo }
            : null,
        before:
          before === oldState.doc ? { from: step.from, to: step.to } : null,
        composing,
      })
    })
  })
  return ops
}

function ownMark(
  node: ProseMirrorNode | null | undefined,
  type: MarkType,
  author: string
) {
  const mark = node ? type.isInSet(node.marks) : undefined
  return mark && mark.attrs.author === author ? mark : null
}

/** Drops the author's own insertions, marks the rest deleted, keeps old deletions. */
function markDeleted(
  fragment: Fragment,
  parent: NodeType,
  types: SuggestionTypes,
  author: string,
  mark: ProseMirrorMark
): Fragment {
  const nodes: ProseMirrorNode[] = []
  fragment.forEach((node) => {
    if (!node.isInline) {
      nodes.push(
        node.copy(markDeleted(node.content, node.type, types, author, mark))
      )
      return
    }
    if (ownMark(node, types.insert, author)) return
    if (types.delete.isInSet(node.marks)) {
      nodes.push(node)
      return
    }
    // A parent that refuses the mark (code block) takes the deletion directly.
    if (!parent.allowsMarkType(types.delete)) return
    nodes.push(node.mark(mark.addToSet(node.marks)))
  })
  return Fragment.fromArray(nodes)
}

// End of the struck run that starts at pos, inside the same textblock.
function deletionRunEnd(doc: ProseMirrorNode, pos: number, type: MarkType) {
  const $pos = doc.resolve(pos)
  const { parent } = $pos
  let end = pos
  for (let index = $pos.index(); index < parent.childCount; index++) {
    const child = parent.child(index)
    if (!type.isInSet(child.marks)) break
    end +=
      index === $pos.index() ? child.nodeSize - $pos.textOffset : child.nodeSize
  }
  return end
}

function trackOps(
  out: Transaction,
  ops: readonly TrackedOp[],
  oldState: EditorState,
  types: SuggestionTypes,
  author: string,
  now: () => string | null,
  createId: () => string,
  direction: DeleteDirection | null
) {
  const fresh = (): SuggestionAttrs => ({ id: createId(), author, time: now() })
  let caret: number | null = null

  for (const op of ops) {
    let attrs: SuggestionAttrs | null = null
    let restored: { from: number; to: number } | null = null

    if (op.deleted) {
      const at = out.mapping.map(op.at, -1)
      const $at = out.doc.resolve(at)
      // Extend a neighboring deletion by the same author; a replace looks left only.
      const neighbor =
        ownMark($at.nodeBefore, types.delete, author) ??
        (op.insert ? null : ownMark($at.nodeAfter, types.delete, author))
      const candidate = neighbor ? attrsOf(neighbor) : fresh()
      const content = markDeleted(
        op.deleted.content,
        op.parent,
        types,
        author,
        types.delete.create(candidate)
      )
      if (hasInline(content)) {
        attrs = candidate
        const steps = out.steps.length
        out.replace(
          at,
          at,
          new Slice(content, op.deleted.openStart, op.deleted.openEnd)
        )
        if (out.steps.length > steps) {
          const map = out.mapping.maps[out.mapping.maps.length - 1]
          restored = { from: map.map(at, -1), to: map.map(at, 1) }
        }
      }
    }

    if (op.insert) {
      let from = out.mapping.map(op.insert.from, 1)
      let to = out.mapping.map(op.insert.to, -1)
      if (from >= to) continue
      const $from = out.doc.resolve(from)
      const runEnd = deletionRunEnd(out.doc, to, types.delete)
      // Typing just before struck text moves past it: deletion, then insertion.
      if (
        !attrs &&
        !op.composing &&
        runEnd > to &&
        $from.sameParent(out.doc.resolve(to))
      ) {
        const caretAtEnd = out.selection.empty && out.selection.head === to
        const moved = out.doc.slice(from, to)
        const size = to - from
        out.delete(from, to)
        from = runEnd - size
        out.replace(from, from, moved)
        to = from + size
        if (caretAtEnd) caret = to
      }
      if (!attrs) {
        const $start = out.doc.resolve(from)
        const merge =
          ownMark($start.nodeBefore, types.insert, author) ??
          ownMark(out.doc.resolve(to).nodeAfter, types.insert, author) ??
          ownMark($start.nodeBefore, types.delete, author)
        attrs = merge ? attrsOf(merge) : fresh()
      }
      out.removeMark(from, to, types.delete)
      out.addMark(from, to, types.insert.create(attrs))
    }

    // Backspace leaves the caret left of the struck text, Delete right; a
    // range with no key behind it (cut, drop) ends right.
    if (ops.length === 1 && !op.insert && restored && op.before) {
      const { selection } = oldState
      const backward = direction
        ? direction === "backward"
        : selection.empty && selection.head === op.before.to
      caret = backward ? restored.from : restored.to
    }
  }

  if (caret != null && !ops.some((op) => op.composing)) {
    out.setSelection(TextSelection.create(out.doc, caret)).scrollIntoView()
  }
}

type DeleteDirection = "backward" | "forward"

// Length of the grapheme next to the caret, so an emoji strikes whole.
function graphemeSize(text: string, direction: DeleteDirection) {
  if (typeof Intl.Segmenter !== "function") return 1
  const parts = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ]
  const part = direction === "backward" ? parts[parts.length - 1] : parts[0]
  return part?.segment.length ?? 1
}

/** Backspace or Delete over original text strikes one character in place (the
 * same text, marked), so history groups a run of keypresses like typing. */
function strikeAtCaret(
  view: EditorView,
  direction: DeleteDirection,
  { tracking, author }: SuggestionTracking,
  now: () => string | null,
  createId: () => string
) {
  const { state } = view
  const types = typesOf(state.schema)
  const { selection } = state
  if (!types || !tracking || !author || view.composing) return false
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const $pos = selection.$head
  if (!$pos.parent.type.allowsMarkType(types.delete)) return false
  const node = direction === "backward" ? $pos.nodeBefore : $pos.nodeAfter
  // Block edges, atoms, struck text and the author's own insertions stay default.
  if (!node?.isText || !node.text) return false
  if (types.delete.isInSet(node.marks)) return false
  if (ownMark(node, types.insert, author)) return false

  const size = graphemeSize(node.text, direction)
  const from = direction === "backward" ? $pos.pos - size : $pos.pos
  const to = from + size
  const neighbor =
    ownMark(state.doc.resolve(from).nodeBefore, types.delete, author) ??
    ownMark(state.doc.resolve(to).nodeAfter, types.delete, author)
  const attrs = neighbor
    ? attrsOf(neighbor)
    : { id: createId(), author, time: now() }
  const content = markDeleted(
    state.doc.slice(from, to).content,
    $pos.parent.type,
    types,
    author,
    types.delete.create(attrs)
  )
  const tr = state.tr.replace(from, to, new Slice(content, 0, 0))
  const caret = direction === "backward" ? from : to
  tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
  view.dispatch(tr.setMeta(suggestionPluginKey, "struck"))
  return true
}

function deleteDirection(event: KeyboardEvent): DeleteDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === "Backspace") return "backward"
  if (event.key === "Delete") return "forward"
  return null
}

// Editing mode: typed text never inherits a suggestion mark.
function clearOps(
  out: Transaction,
  ops: readonly TrackedOp[],
  types: SuggestionTypes
) {
  for (const op of ops) {
    if (!op.insert) continue
    const from = out.mapping.map(op.insert.from, 1)
    const to = out.mapping.map(op.insert.to, -1)
    if (from >= to) continue
    out.removeMark(from, to, types.insert)
    out.removeMark(from, to, types.delete)
  }
}

/** The suggest-mode engine: tracks edits, derives changes, paints the active one. */
export function createSuggestionPlugin({
  getTracking,
  now = () => null,
  createId = createSuggestionId,
}: SuggestionPluginOptions) {
  // The key behind a range deletion, read by the transaction it causes.
  let pendingDirection: DeleteDirection | null = null

  return new Plugin<SuggestionPluginState>({
    key: suggestionPluginKey,
    state: {
      init: (_, state) => buildPluginState(state),
      apply(tr, value, _oldState, newState) {
        if (!tr.docChanged && !tr.selectionSet) return value
        const segments = tr.docChanged
          ? collectSegments(newState.doc)
          : value.segments
        const changes = tr.docChanged
          ? changesFromSegments(segments)
          : value.changes
        const { from, to } = newState.selection
        const activeId = findChangeAt(changes, from, to)
        if (!tr.docChanged && activeId === value.activeId) return value
        return {
          segments,
          changes,
          activeId,
          decorations: buildDecorations(newState.doc, segments, activeId),
        }
      },
    },
    props: {
      decorations: (state) => suggestionPluginKey.getState(state)?.decorations,
      handleDOMEvents: {
        // Runs before every keymap, so a range delete still knows its key.
        keydown(view, event) {
          const direction = deleteDirection(event)
          if (!direction) return false
          if (strikeAtCaret(view, direction, getTracking(), now, createId)) {
            event.preventDefault()
            return true
          }
          pendingDirection = direction
          setTimeout(() => {
            pendingDirection = null
          })
          return false
        },
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const types = typesOf(newState.schema)
      if (!types) return null
      const ops = collectOps(transactions, oldState)
      if (ops.length === 0) return null
      // Keymaps dispatch empty transactions first; the edit takes the key.
      const direction = pendingDirection
      pendingDirection = null
      const out = newState.tr
      const { tracking, author } = getTracking()
      if (tracking && author) {
        trackOps(out, ops, oldState, types, author, now, createId, direction)
      } else {
        clearOps(out, ops, types)
      }
      if (!out.docChanged && !out.selectionSet) return null
      return out.setMeta(suggestionPluginKey, "tracked")
    },
  })
}

function segmentsFor(doc: ProseMirrorNode, ids: readonly string[] | null) {
  return collectSegments(doc).filter(
    (segment) => ids === null || ids.includes(String(segment.mark.attrs.id))
  )
}

// Deletes a span; a span that fills whole textblocks takes the blocks too.
function removeSpan(tr: Transaction, from: number, to: number) {
  const $from = tr.doc.resolve(from)
  const $to = tr.doc.resolve(to)
  const wholeBlocks =
    $from.parent.isTextblock &&
    $to.parent.isTextblock &&
    from === $from.start() &&
    to === $to.end()
  if (wholeBlocks) {
    tr.deleteRange($from.before(), $to.after())
  } else {
    tr.delete(from, to)
  }
}

/** Accepts or rejects the given ids (null = all) on tr; false when none exist. */
export function resolveChanges(
  tr: Transaction,
  resolution: SuggestionResolution,
  ids: readonly string[] | null
) {
  const segments = segmentsFor(tr.doc, ids)
  if (segments.length === 0) return false
  // Accept keeps inserted text and drops deleted text; reject the reverse.
  const keep = resolution === "accept" ? "insert" : "delete"
  for (const segment of segments) {
    if (segment.kind === keep)
      tr.removeMark(segment.from, segment.to, segment.mark)
  }
  // One suggestion split only by block boundaries deletes as one span, which
  // joins its blocks; two suggestions never merge, so no break is lost.
  const spans: { id: string; from: number; to: number }[] = []
  for (const segment of segments) {
    if (segment.kind === keep) continue
    const id = String(segment.mark.attrs.id)
    const last = spans[spans.length - 1]
    if (
      last &&
      last.id === id &&
      !hasLeafBetween(tr.doc, last.to, segment.from)
    ) {
      last.to = Math.max(last.to, segment.to)
    } else {
      spans.push({ id, from: segment.from, to: segment.to })
    }
  }
  for (const span of spans.reverse()) removeSpan(tr, span.from, span.to)
  tr.setMeta(SUGGESTION_SKIP, true)
  return true
}

function resolveCommand(
  resolution: SuggestionResolution,
  ids: readonly string[] | null
): Command {
  return (state, dispatch) => {
    if (!dispatch) return segmentsFor(state.doc, ids).length > 0
    const tr = state.tr
    if (!resolveChanges(tr, resolution, ids)) return false
    dispatch(tr)
    return true
  }
}

export const acceptChange = (id: string) => resolveCommand("accept", [id])
export const rejectChange = (id: string) => resolveCommand("reject", [id])
export const acceptAllChanges = () => resolveCommand("accept", null)
export const rejectAllChanges = () => resolveCommand("reject", null)

const suggestionAttributes = {
  id: {
    default: null,
    parseHTML: (element) => element.getAttribute("data-id"),
    renderHTML: (attributes) =>
      attributes.id ? { "data-id": attributes.id } : {},
  },
  author: {
    default: null,
    parseHTML: (element) => element.getAttribute("data-author"),
    renderHTML: (attributes) =>
      attributes.author ? { "data-author": attributes.author } : {},
  },
  time: {
    default: null,
    parseHTML: (element) => element.getAttribute("data-time"),
    renderHTML: (attributes) =>
      attributes.time ? { "data-time": attributes.time } : {},
  },
} satisfies Attributes

/** Suggested text as <ins>; styled by the prose classes, never inline. */
export const SuggestionInsert = Mark.create({
  name: SUGGESTION_INSERT,
  // Text typed at its edge never joins by inheritance; the plugin decides.
  inclusive: false,
  keepOnSplit: false,
  // Clear formatting leaves suggestions alone.
  clearable: false,
  addAttributes: () => suggestionAttributes,
  // Outranks StarterKit's Underline and Strike rules for the same tags.
  parseHTML: () => [{ tag: "ins[data-id]", priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ["ins", HTMLAttributes, 0],
})

/** Suggested removal as <del>; the text stays until accepted. */
export const SuggestionDelete = Mark.create({
  name: SUGGESTION_DELETE,
  inclusive: false,
  keepOnSplit: false,
  clearable: false,
  addAttributes: () => suggestionAttributes,
  parseHTML: () => [{ tag: "del[data-id]", priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ["del", HTMLAttributes, 0],
})

export interface RichTextChangesOptions {
  /** Author id stamped on new suggestions. */
  author: string
  /** Start in Suggesting mode. */
  tracking: boolean
  /** Stamps new suggestions (an ISO string); the default leaves them unstamped. */
  now: () => string | null
  createId: () => string
}

export type RichTextChangesStorage = SuggestionTracking

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    richTextChanges: {
      acceptChange: (id: string) => ReturnType
      rejectChange: (id: string) => ReturnType
      acceptAllChanges: () => ReturnType
      rejectAllChanges: () => ReturnType
      /** Selects the whole change; the block scrolls it into view. */
      selectChange: (id: string) => ReturnType
    }
  }
  interface Storage {
    richTextChanges: RichTextChangesStorage
  }
}

function runResolution(
  { tr, dispatch }: CommandProps,
  resolution: SuggestionResolution,
  ids: readonly string[] | null
) {
  if (!dispatch) return segmentsFor(tr.doc, ids).length > 0
  return resolveChanges(tr, resolution, ids)
}

/** Suggesting mode: flip storage.tracking and storage.author, no plugin swap.
 * Tracks text in and out; formatting, block type and splits apply directly. */
export const RichTextChanges = Extension.create<
  RichTextChangesOptions,
  RichTextChangesStorage
>({
  name: "richTextChanges",

  addOptions() {
    return {
      author: "",
      tracking: false,
      now: () => null,
      createId: createSuggestionId,
    }
  },

  addStorage() {
    return { tracking: this.options.tracking, author: this.options.author }
  },

  addExtensions() {
    return [SuggestionInsert, SuggestionDelete]
  },

  addCommands() {
    return {
      acceptChange: (id) => (props) => runResolution(props, "accept", [id]),
      rejectChange: (id) => (props) => runResolution(props, "reject", [id]),
      acceptAllChanges: () => (props) => runResolution(props, "accept", null),
      rejectAllChanges: () => (props) => runResolution(props, "reject", null),
      selectChange:
        (id) =>
        ({ tr, dispatch }) => {
          const change = readChanges(tr.doc).find((item) => item.id === id)
          if (!change) return false
          if (dispatch) {
            tr.setSelection(
              TextSelection.create(tr.doc, change.from, change.to)
            )
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    // The same object as editor.storage.richTextChanges, read live.
    const storage = this.storage
    return [
      createSuggestionPlugin({
        getTracking: () => ({
          tracking: storage.tracking,
          author: storage.author,
        }),
        now: this.options.now,
        createId: this.options.createId,
      }),
    ]
  },
})

export interface RichTextChangesSnapshot {
  changes: SuggestionSummary[]
  activeId: string | null
}

export interface RichTextChangesPosition {
  total: number
  /** Index of the change under the caret, or -1. */
  index: number
}

const IDLE_CHANGES: RichTextChangesSnapshot = { changes: [], activeId: null }

function readLive(editor: Editor) {
  const state = suggestionPluginKey.getState(editor.state)
  if (state) return { changes: state.changes, activeId: state.activeId }
  const changes = readChanges(editor.state.doc)
  const { from, to } = editor.state.selection
  return { changes, activeId: findChangeAt(changes, from, to) }
}

function readChangesSnapshot(editor: Editor | null): RichTextChangesSnapshot {
  if (!editor) return IDLE_CHANGES
  const { changes, activeId } = readLive(editor)
  return {
    changes: changes.map(({ id, author, time, kind, inserted, deleted }) => ({
      id,
      author,
      time,
      kind,
      inserted,
      deleted,
    })),
    activeId,
  }
}

function readChangesPosition(editor: Editor | null): RichTextChangesPosition {
  if (!editor) return { total: 0, index: -1 }
  const { changes, activeId } = readLive(editor)
  return {
    total: changes.length,
    index: changes.findIndex((change) => change.id === activeId),
  }
}

/** Changes in document order plus the one under the caret. Positions are left
 * out, so typing elsewhere in the text never re-renders the list. */
export function useRichTextChanges(editor: Editor | null) {
  return useRichTextSelector(editor, readChangesSnapshot)
}

/** Just the count and the caret's place in it, for counters and badges. */
export function useRichTextChangesPosition(editor: Editor | null) {
  return useRichTextSelector(editor, readChangesPosition)
}