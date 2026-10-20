"use client"

/**
 * Tiptap page straight on the host page: one sticky top bar over a page that
 * scrolls with its host, with "/" blocks, "@" mentions, tables, an outline rail
 * on the right and a hover gutter to add, drag and act on any block.
 * Customize: pass content and onSave, or swap PAGE, PAGE_META and PEOPLE in data.ts.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useEditor, type JSONContent } from "@tiptap/react"
import { cn } from "cn"

import { TooltipProvider } from "@/components/ui/tooltip"

// customize: the demo page, its title and the people @ can mention
import { PAGE, PAGE_META, PEOPLE } from "./data"
import { DeleteTableDialog } from "./delete-table-dialog"
import { PageHeader, type SaveState } from "./page-header"
import { RichTextBlockActions } from "./rich-text-block-actions"
import { RichTextBlockGutter } from "./rich-text-block-gutter"
import { RichTextContent } from "./rich-text-content"
import { createRichTextExtensions } from "./rich-text-extensions"
import {
  RichTextFormatBubble,
  showRichTextFormatBubble,
} from "./rich-text-format-bubble"
import { RichTextLinkBubble } from "./rich-text-link"
import {
  createRichTextMention,
  RICH_TEXT_MENTION_PROSE,
} from "./rich-text-mention"
import {
  RichTextOutlineRail,
  scrollToRichTextHeading,
  useRichTextActiveHeading,
  useRichTextOutline,
} from "./rich-text-outline"
import {
  RICH_TEXT_OUTLINE_SLASH_ITEM,
  RichTextOutlineBlock,
} from "./rich-text-outline-node"
import {
  RICH_TEXT_BASIC_SLASH_ITEMS,
  RichTextSlashCommand,
} from "./rich-text-slash-menu"
import { useRichTextSelector } from "./rich-text-state"
import {
  RICH_TEXT_TABLE_PROSE,
  RICH_TEXT_TABLE_SLASH_ITEM,
  RichTextTable,
  RichTextTableBubble,
} from "./rich-text-table"

// Module scope: useEditor compares these by identity on every render.
const EXTENSIONS = [
  ...createRichTextExtensions({ placeholder: "Type / for commands" }),
  RichTextTable,
  RichTextOutlineBlock,
  RichTextBlockActions,
  createRichTextMention(
    PEOPLE.map((person) => ({
      id: person.id,
      label: person.name,
      initials: person.initials,
      description: person.role,
      avatar: person.avatar,
    }))
  ),
  RichTextSlashCommand.configure({
    items: [
      ...RICH_TEXT_BASIC_SLASH_ITEMS,
      RICH_TEXT_TABLE_SLASH_ITEM,
      RICH_TEXT_OUTLINE_SLASH_ITEM,
    ],
  }),
]

// A named textbox, so the slash and mention lists can point at their options.
const EDITOR_PROPS = {
  attributes: {
    role: "textbox",
    "aria-label": `${PAGE_META.title} page`,
    "aria-multiline": "true",
  },
}

// A heading jump lands clear of the sticky header, not under it.
const PAGE_PROSE =
  "[&_.tiptap_:is(h1,h2,h3)]:scroll-mt-[calc(var(--page-header)+--spacing(6))]"

// The block drop line: 2px primary, round ends, centered on the seam (its
// inline height is 1px from a top already raised half a pixel, hence the !).
const DROP_LINE =
  "[&_.prosemirror-dropcursor-block]:text-primary [&_.prosemirror-dropcursor-block]:h-0.5! [&_.prosemirror-dropcursor-block]:-translate-y-[0.5px] [&_.prosemirror-dropcursor-block]:rounded-full"

// How long typing has to pause before the page is handed to onSave.
const SAVE_DELAY_MS = 900

interface PageEditorProps {
  className?: string
  /** The page to open; read once, when the editor is created. */
  content?: JSONContent
  /** Receives the page after each pause in typing. */
  onSave?: (content: JSONContent) => void
}

export function PageEditor({
  className,
  content = PAGE,
  onSave,
}: PageEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [edited, setEdited] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [deleteTableOpen, setDeleteTableOpen] = useState(false)
  const [fullWidth, setFullWidth] = useState(false)
  const [smallText, setSmallText] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    editorProps: EDITOR_PROPS,
    immediatelyRender: false,
    onUpdate: ({ editor: current, transaction }) => {
      // Locking the page emits an update too, but only edits need saving.
      if (!transaction.docChanged) return

      setEdited(true)
      setSaveState("saving")
      window.clearTimeout(saveTimer.current)
      // customize: persist here, or pass onSave
      saveTimer.current = window.setTimeout(() => {
        onSave?.(current.getJSON())
        setSaveState("saved")
      }, SAVE_DELAY_MS)
    },
  })

  const editable = useRichTextSelector(
    editor,
    (current) => current?.isEditable ?? true
  )
  const outline = useRichTextOutline(editor)
  const activeHeading = useRichTextActiveHeading(editor, pageRef, outline)

  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  // The header's height differs per style, so heading jumps, the rail and the
  // caret's scroll inset all follow its measured size.
  useLayoutEffect(() => {
    const root = rootRef.current
    const header = headerRef.current
    if (!root || !header) return

    let height = header.getBoundingClientRect().height

    function applyInsets() {
      root?.style.setProperty("--page-header", `${Math.round(height)}px`)
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

  // Mod-K and the link bubble's Edit both open the link field in the format bar.
  function openLinkEditor() {
    if (!editor?.isEditable || !editor.can().toggleBold()) return

    // No focus() here: a deferred refocus would pull the caret back out of
    // the link field a frame after it opens, and the field would close.
    if (editor.isActive("link")) {
      editor.chain().extendMarkRange("link").run()
    }
    showRichTextFormatBubble(editor)
    setLinkOpen(true)
  }

  function goToHeading(index: number) {
    if (editor) scrollToRichTextHeading(editor, index)
  }

  return (
    <TooltipProvider delay={300}>
      {/* No frame: the page flows in its host, which (or the window) scrolls. */}
      <div
        ref={rootRef}
        className={cn(
          "bg-background text-foreground flex w-full flex-col [--page-header:--spacing(14)]",
          className
        )}
      >
        <PageHeader
          ref={headerRef}
          editor={editor}
          editable={editable}
          edited={edited}
          saveState={saveState}
          outline={outline}
          activeHeading={activeHeading}
          onHeadingSelect={goToHeading}
          fullWidth={fullWidth}
          smallText={smallText}
          onFullWidthChange={setFullWidth}
          onSmallTextChange={setSmallText}
          onLockedChange={(locked) => editor?.setEditable(!locked)}
        />
        <div className="relative flex-1">
          {/* The gutter and the bubbles position against this page box. */}
          <div ref={pageRef} className={cn("relative", DROP_LINE)}>
            <RichTextContent
              editor={editor}
              onLinkShortcut={openLinkEditor}
              className={cn(
                RICH_TEXT_TABLE_PROSE,
                RICH_TEXT_MENTION_PROSE,
                PAGE_PROSE,
                "mx-auto w-full px-4 py-8 sm:px-16 sm:py-12",
                fullWidth ? "max-w-none" : "max-w-3xl",
                smallText && "text-sm/6"
              )}
            />
            {editor ? (
              <>
                <RichTextFormatBubble
                  editor={editor}
                  linkOpen={linkOpen}
                  onLinkOpenChange={setLinkOpen}
                />
                <RichTextLinkBubble editor={editor} onEdit={openLinkEditor} />
                <RichTextTableBubble
                  editor={editor}
                  onDeleteTable={() => setDeleteTableOpen(true)}
                />
                <RichTextBlockGutter
                  editor={editor}
                  editable={editable}
                  scrollerRef={pageRef}
                  onDeleteTable={() => setDeleteTableOpen(true)}
                />
              </>
            ) : null}
          </div>
          {/* A column on the right edge the page's height, so the rail can
              stick below the header while the page scrolls under it. */}
          <div className="pointer-events-none absolute inset-y-0 end-4 max-md:hidden">
            <RichTextOutlineRail
              outline={outline}
              activeIndex={activeHeading}
              onSelect={goToHeading}
              className="pointer-events-auto sticky top-[calc(var(--page-header)+--spacing(24))] z-10"
            />
          </div>
        </div>
      </div>
      <DeleteTableDialog
        editor={editor}
        open={deleteTableOpen}
        onOpenChange={setDeleteTableOpen}
      />
    </TooltipProvider>
  )
}