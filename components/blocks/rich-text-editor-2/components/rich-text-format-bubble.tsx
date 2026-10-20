import { useCallback, useLayoutEffect, useRef } from "react"
import type { EditorState } from "@tiptap/pm/state"
import { isTextSelection, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"

import { RichTextBubbleBar, setRichTextBubble } from "./rich-text-bubble-bar"
import {
  RichTextAlignMenu,
  RichTextBlockTypeMenu,
  RichTextMarkToggles,
} from "./rich-text-controls"
import { RichTextHighlightPopover } from "./rich-text-highlight"
import { RichTextLinkPopover } from "./rich-text-link"
import { useRichTextState } from "./rich-text-state"
import {
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"

const FORMAT_BUBBLE_KEY = "richTextFormatBubble"

const FORMAT_BUBBLE_OPTIONS = { placement: "top", offset: 8 } as const

/** Shows the format bubble now, for a link edit that starts from the keyboard. */
export function showRichTextFormatBubble(editor: Editor) {
  setRichTextBubble(editor, FORMAT_BUBBLE_KEY, "show")
}

interface ShouldShowProps {
  editor: Editor
  element: HTMLElement
  state: EditorState
  from: number
  to: number
}

interface RichTextFormatBubbleProps {
  editor: Editor
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/** Marks, alignment, highlight and link over a text selection; steps aside for code,
 * tables (they have their own bar) and whole links (the link bubble). */
export function RichTextFormatBubble({
  editor,
  linkOpen,
  onLinkOpenChange,
}: RichTextFormatBubbleProps) {
  const state = useRichTextState(editor)
  const linkOpenRef = useRef(linkOpen)

  useLayoutEffect(() => {
    linkOpenRef.current = linkOpen
  }, [linkOpen])

  // Stable identity: a new function would re-register the plugin options.
  const shouldShow = useCallback(
    ({ editor: current, element, state: doc, from, to }: ShouldShowProps) => {
      if (!current.isEditable) return false
      // The link field lives in this bar, so it stays up while it is open.
      if (linkOpenRef.current) return true
      if (!isTextSelection(doc.selection) || doc.selection.empty) return false
      if (!doc.doc.textBetween(from, to).trim()) return false
      if (
        current.isActive("codeBlock") ||
        current.isActive("table") ||
        current.isActive("link")
      ) {
        return false
      }
      return current.view.hasFocus() || element.contains(document.activeElement)
    },
    []
  )

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={FORMAT_BUBBLE_KEY}
      shouldShow={shouldShow}
      options={FORMAT_BUBBLE_OPTIONS}
      className="z-50"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={FORMAT_BUBBLE_KEY}
        label="Format"
        holdOpen={linkOpen}
      >
        <RichTextBlockTypeMenu editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <RichTextMarkToggles editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <RichTextAlignMenu editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <RichTextToolbarGroup label="Annotate">
          <RichTextHighlightPopover editor={editor} state={state} />
          <RichTextLinkPopover
            editor={editor}
            state={state}
            open={linkOpen}
            onOpenChange={onLinkOpenChange}
          />
        </RichTextToolbarGroup>
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}