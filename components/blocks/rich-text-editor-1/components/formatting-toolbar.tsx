import type { Editor } from "@tiptap/react"
import { useTranslations } from "next-intl"

import {
  RichTextAlignMenu,
  RichTextBlockToggles,
  RichTextBlockTypeMenu,
  RichTextHistory,
  RichTextListToggles,
  RichTextMarkToggles,
} from "@/components/blocks/rich-text-editor-2/components/rich-text-controls"
import { RichTextHighlightPopover } from "@/components/blocks/rich-text-editor-2/components/rich-text-highlight"
import { RichTextLinkPopover } from "@/components/blocks/rich-text-editor-2/components/rich-text-link"
import { useRichTextState } from "@/components/blocks/rich-text-editor-2/components/rich-text-state"
import {
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "@/components/blocks/rich-text-editor-2/components/rich-text-toolbar"

interface FormattingToolbarProps {
  editor: Editor | null
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/** Style follows structure so a phone shows the marks without scrolling. */
export function FormattingToolbar({
  editor,
  linkOpen,
  onLinkOpenChange,
}: FormattingToolbarProps) {
  const state = useRichTextState(editor)
  const t = useTranslations('Editor.richText')

  return (
    <RichTextToolbar
      aria-label={t('formatting')}
      className="shrink-0 border-b px-(--frame-panel-header-px) py-(--frame-panel-header-py)"
    >
      <RichTextHistory editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextBlockTypeMenu editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextMarkToggles editor={editor} state={state} />
      <RichTextToolbarGroup label={t('annotate')}>
        <RichTextHighlightPopover editor={editor} state={state} />
        <RichTextLinkPopover
          editor={editor}
          state={state}
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
        />
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextListToggles editor={editor} state={state} />
      <RichTextBlockToggles editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextAlignMenu editor={editor} state={state} />
    </RichTextToolbar>
  )
}