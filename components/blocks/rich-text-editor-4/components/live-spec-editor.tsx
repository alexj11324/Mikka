"use client"

/**
 * A spec co-written live on Tiptap and Yjs: teammates' named carets, presence
 * you can follow, an offline switch that merges on reconnect, and comment
 * threads that sync. Customize: the room seam below, and data.ts.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { Collaboration } from "@tiptap/extension-collaboration"
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret"
import { useEditor, type Editor } from "@tiptap/react"
import { cn } from "cn"
import { toast } from "sonner"
import type * as Y from "yjs"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"

import { CommentBubble } from "./comment-bubble"
import {
  CommentPanel,
  type CommentDraft,
  type OpenThread,
} from "./comment-panel"
import { CURRENT_USER, currentTime, SPEC_META } from "./data"
import { useFollowPeer, useHeaderInsets } from "./follow-peer"
import { TOAST_ERROR_ICON, TOAST_SUCCESS_ICON } from "./icons"
import { createRoomHolder, type RoomAdapter } from "./live-room"
import { openDemoRoom } from "./peer-script"
import type { TeammatePresence } from "./presence-stack"
import { ReplayDialog } from "./replay-dialog"
import {
  addThread,
  canAnchorComment,
  COMMENT_MARK,
  CommentPaint,
  CommentShortcut,
  coversOpenComment,
  getCommentUndoManager,
  readAnchorRanges,
  repaintComments,
  replyToThread,
  RICH_TEXT_COMMENT_PROSE,
  setThreadResolved,
  THREAD_CREATE_ORIGIN,
  toAbsolute,
  toRelativeRange,
  useCommentAnchors,
} from "./rich-text-comments"
import { RichTextContent } from "./rich-text-content"
import { RichTextLinkBubble } from "./rich-text-link"
import { useRichTextSelector } from "./rich-text-state"
import { SPEC_EXTENSIONS, SPEC_FIELD } from "./spec-document"
import { HEADER_PLACEHOLDER, SpecHeader } from "./spec-header"
import {
  awarenessUser,
  firstName,
  renderPeerCaret,
  renderPeerSelection,
} from "./value-faces"

const EDITOR_PROPS = {
  attributes: {
    "aria-label": SPEC_META.title,
    "aria-multiline": "true",
  },
}

const LOCAL_USER = awarenessUser(CURRENT_USER)

// A revealed anchor lands clear of the sticky header, not under it.
const REVEAL_PROSE =
  "[&_.tiptap_[data-comment-id]]:scroll-mt-[calc(var(--spec-header)+--spacing(6))]"

const CONTENT = "mx-auto w-full max-w-3xl py-8 sm:py-10"

const ROOT =
  "bg-background text-foreground flex w-full flex-col [--spec-header:--spacing(26)] [--spec-offset:0px]"

const COLUMNS =
  "mx-auto flex w-full max-w-6xl flex-1 items-start gap-10 px-4 sm:px-6"

// Capped to the viewport below the header; a host bar above the scroller is
// subtracted through --spec-offset.
const MARGIN =
  "sticky top-(--spec-header) flex max-h-[calc(100svh-var(--spec-offset)-var(--spec-header))] w-80 shrink-0 flex-col py-10"

const UNDO_TOAST_MS = 8000

// Below lg the comment margin rides a Sheet; a 320px rail beside a readable
// column needs about 1024px.
const LG_QUERY = "(max-width: 1023px)"

function subscribeBelowLg(onChange: () => void) {
  const query = window.matchMedia(LG_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function useIsBelowLg() {
  return useSyncExternalStore(
    subscribeBelowLg,
    () => window.matchMedia(LG_QUERY).matches,
    () => false
  )
}

function listNames(ids: string[]) {
  return new Intl.ListFormat("en-US").format(ids.map(firstName))
}

const getNoRoom = () => null

export function LiveSpecEditor({ className }: { className?: string }) {
  // customize: hand createRoomHolder your provider's room (Hocuspocus,
  // y-websocket, Liveblocks) as a RoomAdapter; the editor binds room.local.
  const [holder] = useState(() => createRoomHolder(openDemoRoom))
  const [generation, setGeneration] = useState(0)
  const [replayOpen, setReplayOpen] = useState(false)
  const room = useSyncExternalStore(holder.subscribe, holder.get, getNoRoom)

  useEffect(() => {
    const opened = holder.open()
    return () => holder.close(opened)
  }, [holder, generation])

  function requestReplay(editedLocally: boolean) {
    if (editedLocally) {
      setReplayOpen(true)
    } else {
      setGeneration((value) => value + 1)
    }
  }

  function confirmReplay() {
    setReplayOpen(false)
    setGeneration((value) => value + 1)
    toast.success("Session restarted", {
      icon: TOAST_SUCCESS_ICON,
      description: "Your edits were discarded.",
    })
  }

  return (
    <TooltipProvider delay={300}>
      {room ? (
        <SpecSession
          key={room.key}
          room={room}
          onReplay={requestReplay}
          className={className}
        />
      ) : (
        <SpecSkeleton className={className} />
      )}
      <ReplayDialog
        open={replayOpen}
        onOpenChange={setReplayOpen}
        onConfirm={confirmReplay}
      />
    </TooltipProvider>
  )
}

/** The page's shape for the moment before the room opens, margin included. */
function SpecSkeleton({ className }: { className?: string }) {
  return (
    <div aria-busy="true" className={cn(ROOT, className)}>
      <SpecHeader
        editor={null}
        {...HEADER_PLACEHOLDER}
        linkOpen={false}
        onLinkOpenChange={() => {}}
        onReplay={() => {}}
      />
      <div className={COLUMNS}>
        <div className="min-w-0 flex-1">
          <RichTextContent editor={null} className={CONTENT} />
        </div>
        <div className={cn(MARGIN, "max-lg:hidden")}>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Comments</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

interface DraftAnchor extends CommentDraft {
  from: Y.RelativePosition
  to: Y.RelativePosition
}

interface SpecSessionProps {
  room: RoomAdapter
  /** Receives whether you changed anything, which calls for a confirm. */
  onReplay: (editedLocally: boolean) => void
  className?: string
}

function SpecSession({ room, onReplay, className }: SpecSessionProps) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<DraftAnchor | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const sheetHeadingRef = useRef<HTMLHeadingElement>(null)
  const draftFieldRef = useRef<HTMLTextAreaElement>(null)
  // A row picked in the Sheet hands the caret to the text as the Sheet closes.
  const pickedRef = useRef(false)
  const startCommentRef = useRef<() => void>(() => {})
  const createdRef = useRef(0)
  const belowLg = useIsBelowLg()
  const { isOpen } = room.threads

  const connection = useSyncExternalStore(
    room.connection.subscribe,
    room.connection.getSnapshot,
    room.connection.getSnapshot
  )
  const presence = useSyncExternalStore(
    room.presence.subscribe,
    room.presence.getSnapshot,
    room.presence.getSnapshot
  )
  const threads = useSyncExternalStore(
    room.threads.subscribe,
    room.threads.getSnapshot,
    room.threads.getSnapshot
  )

  // One set per room: Collaboration binds its document once, at creation.
  const { extensions, undoManager } = useMemo(() => {
    const { doc: document, awareness } = room.local
    const undoManager = getCommentUndoManager(document, SPEC_FIELD)
    return {
      undoManager,
      extensions: [
        ...SPEC_EXTENSIONS,
        CommentPaint.configure({ isOpen }),
        CommentShortcut.configure({
          isOpen,
          onComment: () => startCommentRef.current(),
        }),
        Collaboration.configure({
          document,
          field: SPEC_FIELD,
          yUndoOptions: { undoManager },
        }),
        CollaborationCaret.configure({
          provider: { awareness },
          user: LOCAL_USER,
          render: renderPeerCaret,
          selectionRender: renderPeerSelection,
        }),
      ],
    }
  }, [room, isOpen])

  const editor = useEditor({
    extensions,
    editorProps: EDITOR_PROPS,
    immediatelyRender: false,
  })

  const { anchors, activeId } = useCommentAnchors(editor)
  const canComment = useRichTextSelector(
    editor,
    useCallback(
      (current: Editor | null) => canAnchorComment(current, isOpen),
      [isOpen]
    )
  )

  // Offline nobody's state is known, so the last known faces stay, unsynced.
  const teammates: TeammatePresence[] = presence
    .filter((entry) => entry.here || !connection.online)
    .map((entry) => ({
      id: entry.id,
      presence: connection.online ? entry.status : "unsynced",
      followable: connection.online && entry.hasCaret,
    }))
  // A teammate who loses their caret (or the connection) ends the follow.
  const followed = teammates.some(
    (item) => item.id === following && item.followable
  )
    ? following
    : null

  const replying: Record<string, string[]> = {}
  for (const entry of presence) {
    if (entry.here && entry.replyingTo) {
      ;(replying[entry.replyingTo] ??= []).push(firstName(entry.id))
    }
  }

  const listed = new Set<string>()
  const openThreads: OpenThread[] = []
  for (const anchor of anchors) {
    const thread = threads[anchor.id]
    if (thread && !thread.resolved && !listed.has(anchor.id)) {
      listed.add(anchor.id)
      openThreads.push({ thread, excerpt: anchor.excerpt })
    }
  }
  // A thread whose text a teammate deleted stays open, last in the list.
  for (const thread of Object.values(threads)) {
    if (!thread.resolved && !listed.has(thread.id)) {
      openThreads.push({ thread, excerpt: null })
    }
  }

  // Resolve and reopen on any client re-read which anchors are painted.
  useEffect(() => {
    if (!editor) return
    return room.threads.subscribe(() =>
      queueMicrotask(() => repaintComments(editor))
    )
  }, [editor, room])

  const stopFollowing = useCallback(() => setFollowing(null), [])

  useHeaderInsets(rootRef, headerRef, editor)
  useFollowPeer({
    editor,
    followed,
    rootRef,
    headerRef,
    onStop: stopFollowing,
  })

  function toggleFollow(id: string) {
    setFollowing((current) => (current === id ? null : id))
  }

  // Syncing renders into the editor at once, so it runs here in the handler.
  function changeConnection(online: boolean) {
    const { flushed, merged } = room.setOnline(online)
    if (!online) {
      setFollowing(null)
      return
    }
    const title =
      flushed > 0
        ? `Synced ${flushed} local ${flushed === 1 ? "change" : "changes"}`
        : "Back online"
    const description =
      merged.length > 0
        ? `Merged with edits from ${listNames(merged)}, no conflicts.`
        : flushed > 0
          ? "Everyone in the room has your edits."
          : "Already up to date."
    toast.success(title, { icon: TOAST_SUCCESS_ICON, description })
  }

  function openLinkFromKeyboard() {
    setLinkOpen(Boolean(editor?.can().toggleBold()))
  }

  // Selects the anchor and centers it, clear of the header; you chose where to
  // look, so a follow ends. The DOM scroll works while focus stays in the list.
  function revealThread(id: string) {
    if (!editor) return
    const range = readAnchorRanges(editor.state.doc).find(
      (anchor) => anchor.id === id
    )
    if (!range) return
    setFollowing(null)
    editor.commands.setTextSelection({ from: range.from, to: range.to })

    const target = editor.view.dom.querySelector(
      `[data-comment-id="${CSS.escape(id)}"]`
    )
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    target?.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    })
  }

  // In the Sheet a pick makes the row current (replies and the reply field
  // open in place); the text is waiting once the Sheet closes.
  function selectFromSheet(id: string) {
    pickedRef.current = true
    revealThread(id)
  }

  function openSheet() {
    pickedRef.current = false
    setSheetOpen(true)
  }

  // After a pick the caret goes to the text; otherwise the opener gets focus.
  function sheetReturnFocus() {
    return pickedRef.current && editor ? editor.view.dom : true
  }

  function sheetInitialFocus() {
    return draftFieldRef.current ?? sheetHeadingRef.current ?? true
  }

  function startComment() {
    if (!editor || !canAnchorComment(editor, isOpen)) return
    const { from, to } = editor.state.selection
    const range = toRelativeRange(editor, from, to)
    if (!range) return
    const before = readAnchorRanges(editor.state.doc).filter(
      (anchor) => anchor.from < from
    )
    const index = openThreads.filter(({ thread }) =>
      before.some((anchor) => anchor.id === thread.id)
    ).length
    setDraft({
      ...range,
      index,
      excerpt: editor.state.doc.textBetween(from, to, " "),
    })
    if (belowLg) openSheet()
  }

  useLayoutEffect(() => {
    startCommentRef.current = startComment
  })

  function closeDraft() {
    setDraft(null)
    if (belowLg) setSheetOpen(false)
  }

  function submitDraft(body: string) {
    if (!editor || !draft) return
    const from = toAbsolute(editor, draft.from)
    const to = toAbsolute(editor, draft.to)
    if (from === null || to === null || from >= to) {
      closeDraft()
      toast.error("Comment not added", {
        icon: TOAST_ERROR_ICON,
        description: "A teammate removed the selected text.",
      })
      return
    }
    // The draft stays open, so the words you wrote are not lost.
    if (coversOpenComment(editor.state.doc, from, to, isOpen)) {
      toast.error("Comment not added", {
        icon: TOAST_ERROR_ICON,
        description: "A teammate commented on this text first.",
      })
      return
    }
    closeDraft()

    createdRef.current += 1
    const id = `t-${room.local.doc.clientID}-${createdRef.current}`
    const at = currentTime()
    // Record and anchor form one undo step, apart from any typing around it.
    undoManager.stopCapturing()
    addThread(
      room.local.doc,
      {
        id,
        author: CURRENT_USER,
        createdAt: at,
        messages: [{ author: CURRENT_USER, body, at }],
      },
      THREAD_CREATE_ORIGIN
    )
    editor
      .chain()
      .setTextSelection({ from, to })
      .setMark(COMMENT_MARK, { id })
      .setTextSelection(to)
      .focus()
      .run()
    undoManager.stopCapturing()
    toast.success("Comment added", {
      icon: TOAST_SUCCESS_ICON,
      description: `“${draft.excerpt}”`,
    })
  }

  function cancelDraft() {
    closeDraft()
    editor?.commands.focus()
  }

  function resolveThread(id: string) {
    const doc = room.local.doc
    if (!setThreadResolved(doc, id, true)) return
    const excerpt = openThreads.find((item) => item.thread.id === id)?.excerpt
    toast.success("Thread resolved", {
      icon: TOAST_SUCCESS_ICON,
      description: excerpt ? `“${excerpt}”` : undefined,
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          // A replay since then retired this room.
          if (!doc.isDestroyed) setThreadResolved(doc, id, false)
        },
      },
    })
  }

  function replyThread(id: string, body: string) {
    replyToThread(room.local.doc, id, {
      author: CURRENT_USER,
      body,
      at: currentTime(),
    })
  }

  function panel(inSheet: boolean) {
    return (
      <CommentPanel
        threads={openThreads}
        activeId={activeId}
        draft={draft}
        replying={replying}
        onSelect={inSheet ? selectFromSheet : revealThread}
        onResolve={resolveThread}
        onReply={replyThread}
        onDraftSubmit={submitDraft}
        onDraftCancel={cancelDraft}
        draftFieldRef={draftFieldRef}
        onClose={inSheet ? () => setSheetOpen(false) : undefined}
        headingRef={inSheet ? sheetHeadingRef : undefined}
        className={inSheet ? "h-full py-4" : undefined}
      />
    )
  }

  return (
    <>
      {/* The fallback height holds until the header is measured. */}
      <div
        ref={rootRef}
        className={cn(
          // customize: --spec-offset is the height of any host bar above the scroller
          ROOT,
          className
        )}
      >
        <SpecHeader
          ref={headerRef}
          editor={editor}
          connection={{
            online: connection.online,
            pending: connection.pending,
            edited: connection.edited,
            onChange: changeConnection,
          }}
          presence={{
            teammates,
            following: followed,
            onFollow: toggleFollow,
            onStop: stopFollowing,
          }}
          comments={{
            canComment,
            onComment: startComment,
            open: openThreads.length,
            showButton: belowLg,
            onOpenList: openSheet,
          }}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          onReplay={() => onReplay(connection.editedLocally)}
        />

        <div className={COLUMNS}>
          <div className="min-w-0 flex-1">
            <RichTextContent
              editor={editor}
              onLinkShortcut={openLinkFromKeyboard}
              className={cn(RICH_TEXT_COMMENT_PROSE, REVEAL_PROSE, CONTENT)}
            />
            {editor ? (
              <>
                <CommentBubble
                  editor={editor}
                  isOpen={isOpen}
                  onComment={startComment}
                />
                <RichTextLinkBubble
                  editor={editor}
                  onEdit={() => setLinkOpen(true)}
                />
              </>
            ) : null}
          </div>

          {belowLg ? null : (
            <aside aria-label="Discussion" className={MARGIN}>
              {panel(false)}
            </aside>
          )}
        </div>
      </div>

      {/* Mounted closed so the first open still plays the sheet transition. */}
      <Sheet open={belowLg && sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          initialFocus={sheetInitialFocus}
          finalFocus={sheetReturnFocus}
          showCloseButton={false}
          className="w-full gap-0 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Comments</SheetTitle>
            <SheetDescription>
              Reply to or resolve each open thread.
            </SheetDescription>
          </SheetHeader>
          {panel(true)}
        </SheetContent>
      </Sheet>
    </>
  )
}