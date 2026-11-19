import type { Editor } from "@tiptap/react"
import {
  RichTextBlockTypeMenu,
  RichTextHistory,
  RichTextListToggles,
} from "./rich-text-controls"
import { RichTextLinkPopover } from "./rich-text-link"
import type { RichTextSnapshot } from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { Bold, Italic, Underline, MessageSquareText } from "@/components/icons"

interface SpecToolbarProps {
  editor: Editor | null
  state: RichTextSnapshot
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  canComment: boolean
  onComment: () => void
}

/** The kit's toolbar for a spec: no highlight, which would read as a comment. */
export function SpecToolbar({
  editor,
  state,
  linkOpen,
  onLinkOpenChange,
  canComment,
  onComment,
}: SpecToolbarProps) {
  const disabled = !state.canFormat

  return (
    <RichTextToolbar aria-label="Formatting" className="min-w-0 flex-1">
      <RichTextHistory editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextBlockTypeMenu editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextToolbarGroup label="Text style">
        <RichTextToggle
          label="Bold"
          shortcut={["mod", "B"]}
          pressed={state.bold}
          disabled={disabled}
          onToggle={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold aria-hidden="true" />
        </RichTextToggle>
        <RichTextToggle
          label="Italic"
          shortcut={["mod", "I"]}
          pressed={state.italic}
          disabled={disabled}
          onToggle={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic aria-hidden="true" />
        </RichTextToggle>
        <RichTextToggle
          label="Underline"
          shortcut={["mod", "U"]}
          pressed={state.underline}
          disabled={disabled}
          onToggle={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <Underline aria-hidden="true" />
        </RichTextToggle>
        <RichTextLinkPopover
          editor={editor}
          state={state}
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
        />
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextListToggles editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextToolbarGroup label="Comments">
        <RichTextButton
          label="Comment"
          shortcut={["mod", "alt", "M"]}
          disabled={!canComment}
          onClick={onComment}
        >
          <MessageSquareText aria-hidden="true" />
        </RichTextButton>
      </RichTextToolbarGroup>
    </RichTextToolbar>
  )
}