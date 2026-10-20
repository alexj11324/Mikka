import { Extension, type Editor } from "@tiptap/react"
import {
  RichTextAlignMenu,
  RichTextBlockTypeMenu,
  RichTextHistory,
} from "./rich-text-controls"
import { RichTextLinkPopover } from "./rich-text-link"
import type { RichTextSnapshot } from "./rich-text-state"
import {
  RichTextToggle,
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { BoldIcon, ItalicIcon, UnderlineIcon, ListIcon, ListOrderedIcon } from "lucide-react"

/** Strike, code, checklists and highlights would look like a redline but are
 * never tracked, so a contract drops their keys along with their buttons. */
export const ContractFormattingScope = Extension.create({
  name: "contractFormattingScope",
  // Ahead of StarterKit, so these keys resolve here first.
  priority: 1000,
  addKeyboardShortcuts() {
    const quiet = () => true
    return {
      "Mod-Shift-s": quiet,
      "Mod-e": quiet,
      "Mod-Alt-c": quiet,
      "Mod-Shift-9": quiet,
      "Mod-Shift-h": quiet,
    }
  },
})

/** Markdown rules that stay live; the rest match the toolbar's scope. */
export const CONTRACT_INPUT_RULES = [
  "bold",
  "italic",
  "heading",
  "bulletList",
  "orderedList",
]

export const CONTRACT_PASTE_RULES = ["bold", "italic", "link"]

interface ContractToolbarProps {
  editor: Editor | null
  state: RichTextSnapshot
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/** The kit's toolbar, composed down to what a contract uses. */
export function ContractToolbar({
  editor,
  state,
  linkOpen,
  onLinkOpenChange,
}: ContractToolbarProps) {
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
          <BoldIcon aria-hidden="true" />
        </RichTextToggle>
        <RichTextToggle
          label="Italic"
          shortcut={["mod", "I"]}
          pressed={state.italic}
          disabled={disabled}
          onToggle={() => editor?.chain().focus().toggleItalic().run()}
        >
          <ItalicIcon aria-hidden="true" />
        </RichTextToggle>
        <RichTextToggle
          label="Underline"
          shortcut={["mod", "U"]}
          pressed={state.underline}
          disabled={disabled}
          onToggle={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon aria-hidden="true" />
        </RichTextToggle>
        <RichTextLinkPopover
          editor={editor}
          state={state}
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
        />
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextToolbarGroup label="Lists">
        <RichTextToggle
          label="Bullet list"
          shortcut={["mod", "shift", "8"]}
          pressed={state.bulletList}
          disabled={!state.editable}
          onToggle={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <ListIcon aria-hidden="true" />
        </RichTextToggle>
        <RichTextToggle
          label="Numbered list"
          shortcut={["mod", "shift", "7"]}
          pressed={state.orderedList}
          disabled={!state.editable}
          onToggle={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrderedIcon aria-hidden="true" />
        </RichTextToggle>
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextAlignMenu editor={editor} state={state} />
    </RichTextToolbar>
  )
}