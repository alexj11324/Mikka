"use client"

/**
 * Contract redline on Tiptap, straight on the page: one sticky header (identity
 * plus toolbar) over the document, with a review margin pinned beneath it.
 * Customize: pass content, or swap CONTRACT, CONTRACT_META and PEOPLE in data.tsx.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useEditor, type Editor, type JSONContent } from "@tiptap/react"
import { cn } from "cn"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ContractHeader } from "./contract-header"
import {
  CONTRACT_INPUT_RULES,
  CONTRACT_PASTE_RULES,
  ContractFormattingScope,
} from "./contract-toolbar"
// customize: the contract, its people, the signed-in author and the clock
import { CONTRACT, CONTRACT_META, CURRENT_AUTHOR, currentTime } from "./data"
import type { EditorMode } from "./mode-select"
import { ResolveAllDialog } from "./resolve-all-dialog"
import {
  readChanges,
  RICH_TEXT_CHANGES_PROSE,
  RICH_TEXT_MARKUP_VIEW,
  RichTextChanges,
  type RichTextMarkupView,
  type SuggestionResolution,
} from "./rich-text-changes"
import { RichTextContent } from "./rich-text-content"
import { createRichTextExtensions } from "./rich-text-extensions"
import { RichTextLinkBubble } from "./rich-text-link"
import { useRichTextSelector } from "./rich-text-state"
import { SuggestionPanel } from "./suggestion-panel"

// Module scope: useEditor compares these by identity on every render.
const EXTENSIONS = [
  ...createRichTextExtensions({ placeholder: "Write a clause" }),
  ContractFormattingScope,
  // now stamps new suggestions from the block's one clock (data.tsx)
  RichTextChanges.configure({
    author: CURRENT_AUTHOR,
    tracking: true,
    now: currentTime,
  }),
]

const EDITOR_PROPS = {
  attributes: {
    "aria-label": CONTRACT_META.title,
    "aria-multiline": "true",
  },
}

// A revealed change lands clear of the sticky header, not under it.
const REVEAL_PROSE =
  "[&_.tiptap_:is(ins,del)]:scroll-mt-[calc(var(--redline-header)+--spacing(6))]"

const REVEAL_BLOCKS = "p, h1, h2, h3, li, blockquote"

// The first painted element of a change; a preview hides one side of it, and a
// pure deletion in Final (or insertion in Original) falls back to its block.
function revealTarget(editor: Editor, id: string) {
  const marked = editor.view.dom.querySelectorAll(
    `[data-id="${CSS.escape(id)}"]`
  )
  const painted = Array.from(marked).find(
    (element) => element.getClientRects().length > 0
  )
  if (painted) return painted

  const change = readChanges(editor.state.doc).find((item) => item.id === id)
  if (!change) return null
  const { node } = editor.view.domAtPos(change.from)
  let block = (node instanceof Element ? node : node.parentElement)?.closest(
    REVEAL_BLOCKS
  )
  // A block the preview hides whole hands off to the nearest one above it.
  while (block && block.getClientRects().length === 0) {
    block = block.previousElementSibling
  }
  return block ?? null
}

// Below lg the review margin rides a Sheet; a 288px rail beside a readable
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

interface ContractEditorProps {
  className?: string
  /** The contract to open; read once, when the editor is created. */
  content?: JSONContent
}

export function ContractEditor({
  className,
  content = CONTRACT,
}: ContractEditorProps) {
  const [mode, setMode] = useState<EditorMode>("suggesting")
  const [markup, setMarkup] = useState<RichTextMarkupView>("all")
  const [edited, setEdited] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState<{
    resolution: SuggestionResolution
    count: number
  }>({ resolution: "accept", count: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const sheetHeadingRef = useRef<HTMLHeadingElement>(null)
  // A row picked in the Sheet hands the caret to the text as the Sheet closes.
  const pickedRef = useRef(false)
  const belowLg = useIsBelowLg()

  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    editorProps: EDITOR_PROPS,
    enableInputRules: CONTRACT_INPUT_RULES,
    enablePasteRules: CONTRACT_PASTE_RULES,
    immediatelyRender: false,
    onUpdate: ({ transaction }) => {
      // A mode switch emits an update too; only edits restamp the header.
      if (transaction.docChanged) setEdited(true)
    },
  })

  const editable = useRichTextSelector(
    editor,
    (current) => current?.isEditable ?? true
  )
  // Previews and Viewing read the list but never resolve it.
  const canResolve = mode !== "viewing" && markup === "all"

  // Suggesting stamps new edits; previews lock the text until All markup.
  useEffect(() => {
    if (!editor) return

    editor.storage.richTextChanges.tracking = mode === "suggesting"
    editor.setEditable(mode !== "viewing" && markup === "all")
  }, [editor, mode, markup])

  // The header's height differs per style and wraps on phones, so the review
  // margin and the caret's scroll inset follow its measured size.
  useLayoutEffect(() => {
    const root = rootRef.current
    const header = headerRef.current
    if (!root || !header) return

    let height = header.getBoundingClientRect().height

    function applyInsets() {
      root?.style.setProperty("--redline-header", `${Math.round(height)}px`)
      // isDestroyed is true until the view mounts, and setProps needs the view.
      if (!editor || editor.isDestroyed) return
      editor.view.setProps({
        scrollThreshold: { top: height + 8, right: 0, bottom: 32, left: 0 },
        scrollMargin: { top: height + 24, right: 0, bottom: 48, left: 0 },
      })
    }

    applyInsets()
    editor?.on("mount", applyInsets)

    const observer = new ResizeObserver(([entry]) => {
      height =
        entry?.borderBoxSize[0]?.blockSize ??
        header.getBoundingClientRect().height
      applyInsets()
    })
    observer.observe(header)

    return () => {
      observer.disconnect()
      editor?.off("mount", applyInsets)
    }
  }, [editor])

  function openLinkFromKeyboard() {
    setLinkOpen(editable && Boolean(editor?.can().toggleBold()))
  }

  // Selects the change and centers it, clear of the header. The DOM scroll
  // works while focus stays in the review list, where the view's would not.
  function revealChange(id: string) {
    if (!editor?.commands.selectChange(id)) return

    const target = revealTarget(editor, id)
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    target?.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    })
  }

  function selectFromList(id: string) {
    // The Sheet covers the text on small screens, so it steps aside.
    pickedRef.current = true
    setSheetOpen(false)
    revealChange(id)
  }

  function openSheet() {
    pickedRef.current = false
    setSheetOpen(true)
  }

  // After a pick the caret goes to the text (when it takes one); otherwise the
  // opener gets focus back.
  function sheetReturnFocus() {
    return pickedRef.current && editor?.isEditable ? editor.view.dom : true
  }

  // Instant and undoable with Mod-Z, so no confirm and no toast.
  function resolveOne(id: string, resolution: SuggestionResolution) {
    if (!editor) return

    if (resolution === "accept") {
      editor.commands.acceptChange(id)
    } else {
      editor.commands.rejectChange(id)
    }
  }

  function confirmResolveAll(resolution: SuggestionResolution) {
    if (!editor) return
    setBulk({ resolution, count: readChanges(editor.state.doc).length })
    setBulkOpen(true)
  }

  function stepHistory(step: "undo" | "redo") {
    if (step === "undo") {
      editor?.commands.undo()
    } else {
      editor?.commands.redo()
    }
  }

  function panel(inSheet: boolean) {
    return (
      <SuggestionPanel
        editor={editor}
        canResolve={canResolve}
        markup={markup}
        onMarkupChange={setMarkup}
        onSelect={inSheet ? selectFromList : revealChange}
        onResolve={resolveOne}
        onResolveAll={confirmResolveAll}
        onHistory={stepHistory}
        onClose={inSheet ? () => setSheetOpen(false) : undefined}
        headingRef={inSheet ? sheetHeadingRef : undefined}
        className={inSheet ? "h-full py-4" : undefined}
      />
    )
  }

  return (
    <TooltipProvider delay={300}>
      {/* The fallback height holds until the header is measured. */}
      <div
        ref={rootRef}
        className={cn(
          // customize: --redline-offset is the height of any host bar above the scroller
          "bg-background text-foreground flex w-full flex-col [--redline-header:--spacing(26)] [--redline-offset:0px]",
          className
        )}
      >
        <ContractHeader
          ref={headerRef}
          editor={editor}
          mode={mode}
          onModeChange={setMode}
          edited={edited}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          onReveal={revealChange}
          showSuggestionsButton={belowLg}
          onOpenSuggestions={openSheet}
        />

        <div className="mx-auto flex w-full max-w-6xl flex-1 items-start gap-10 px-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <RichTextContent
              editor={editor}
              onLinkShortcut={openLinkFromKeyboard}
              className={cn(
                RICH_TEXT_CHANGES_PROSE,
                RICH_TEXT_MARKUP_VIEW[markup],
                REVEAL_PROSE,
                "mx-auto w-full max-w-3xl py-8 sm:py-10"
              )}
            />
            {editor ? (
              <RichTextLinkBubble
                editor={editor}
                onEdit={() => setLinkOpen(true)}
              />
            ) : null}
          </div>

          {/* Capped to the viewport below the header; a host bar above the
              scroller is subtracted through --redline-offset. */}
          {belowLg ? null : (
            <aside
              aria-label="Review"
              className="sticky top-(--redline-header) flex max-h-[calc(100svh-var(--redline-offset)-var(--redline-header))] w-80 shrink-0 flex-col py-10"
            >
              {panel(false)}
            </aside>
          )}
        </div>
      </div>

      {/* Mounted closed so the first open still plays the sheet transition. */}
      <Sheet open={belowLg && sheetOpen} onOpenChange={setSheetOpen}>
        {/* Banded: the panel's head over an edge to edge list on its 16px
            gutter; focus opens on the heading, which pops no tooltip. */}
        <SheetContent
          side="right"
          initialFocus={sheetHeadingRef}
          finalFocus={sheetReturnFocus}
          showCloseButton={false}
          className="w-full gap-0 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Suggestions</SheetTitle>
            <SheetDescription>
              Accept or reject each proposed change.
            </SheetDescription>
          </SheetHeader>
          {panel(true)}
        </SheetContent>
      </Sheet>

      <ResolveAllDialog
        editor={editor}
        open={bulkOpen}
        resolution={bulk.resolution}
        count={bulk.count}
        onOpenChange={setBulkOpen}
        returnToText={!sheetOpen}
        onResolved={() => setSheetOpen(false)}
      />
    </TooltipProvider>
  )
}