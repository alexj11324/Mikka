import type { ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  RICH_TEXT_ALIGNS,
  type RichTextAlign,
  type RichTextBlockType,
  type RichTextSnapshot,
} from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbarGroup,
  useShortcutLabel,
} from "./rich-text-toolbar"
import { Undo2Icon, Redo2Icon, TypeIcon, Heading1Icon, Heading2Icon, Heading3Icon, ChevronDownIcon, ListIcon, ListOrderedIcon, ListTodoIcon, TextQuoteIcon, SquareCodeIcon, MinusIcon, BoldIcon, ItalicIcon, UnderlineIcon, StrikethroughIcon, CodeIcon, AlignLeftIcon, AlignCenterIcon, AlignRightIcon, AlignJustifyIcon } from "lucide-react"

interface ControlProps {
  editor: Editor | null
  state: RichTextSnapshot
}

// Closing a menu hands the caret back to the text, not to the trigger.
function focusEditor(editor: Editor | null) {
  return () => editor?.view.dom ?? true
}

export function RichTextHistory({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  return (
    <RichTextToolbarGroup label={t('history')}>
      <RichTextButton
        label={t('undo')}
        shortcut={["mod", "Z"]}
        disabled={!state.canUndo}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2Icon aria-hidden="true" />
      </RichTextButton>
      <RichTextButton
        label={t('redo')}
        shortcut={["mod", "shift", "Z"]}
        disabled={!state.canRedo}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2Icon aria-hidden="true" />
      </RichTextButton>
    </RichTextToolbarGroup>
  )
}

interface BlockTypeOption {
  value: RichTextBlockType
  labelKey: 'paragraph' | 'heading1' | 'heading2' | 'heading3'
  icon: ReactNode
  keys: readonly string[]
}

// Whole static glyphs per type, so the trigger can mirror the current block.
const BLOCK_TYPES: BlockTypeOption[] = [
  {
    value: "paragraph",
    labelKey: "paragraph",
    keys: ["mod", "alt", "0"],
    icon: (
      <TypeIcon aria-hidden="true" />
    ),
  },
  {
    value: "heading-1",
    labelKey: "heading1",
    keys: ["mod", "alt", "1"],
    icon: (
      <Heading1Icon aria-hidden="true" />
    ),
  },
  {
    value: "heading-2",
    labelKey: "heading2",
    keys: ["mod", "alt", "2"],
    icon: (
      <Heading2Icon aria-hidden="true" />
    ),
  },
  {
    value: "heading-3",
    labelKey: "heading3",
    keys: ["mod", "alt", "3"],
    icon: (
      <Heading3Icon aria-hidden="true" />
    ),
  },
]

const isBlockType = (value: unknown): value is RichTextBlockType =>
  BLOCK_TYPES.some((option) => option.value === value)

function setBlockType(editor: Editor | null, value: RichTextBlockType) {
  const chain = editor?.chain().focus()

  if (value === "heading-1") chain?.setHeading({ level: 1 }).run()
  else if (value === "heading-2") chain?.setHeading({ level: 2 }).run()
  else if (value === "heading-3") chain?.setHeading({ level: 3 }).run()
  else chain?.setParagraph().run()
}

function MenuShortcut({ keys }: { keys: readonly string[] }) {
  return <DropdownMenuShortcut>{useShortcutLabel(keys)}</DropdownMenuShortcut>
}

export function RichTextBlockTypeMenu({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  const current =
    BLOCK_TYPES.find((option) => option.value === state.blockType) ??
    BLOCK_TYPES[0]
  const currentLabel = t(`blockType.${current.labelKey}`)

  // Fixed width on desktop, so the bar never shifts as the label changes;
  // the current block's glyph alone below sm, so the marks stay in view.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('blockTypeAria', { type: currentLabel })}
            disabled={!state.editable || state.codeBlock}
            className="shrink-0 justify-between sm:w-28"
            data-toolbar-item=""
          />
        }
      >
        <span className="flex sm:hidden">{current.icon}</span>
        <span className="truncate max-sm:hidden">{currentLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-auto"
        finalFocus={focusEditor(editor)}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('turnInto')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.blockType}
            onValueChange={(value) => {
              if (isBlockType(value)) setBlockType(editor, value)
            }}
          >
            {BLOCK_TYPES.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={option.value !== "paragraph" && !state.canHeading}
                closeOnClick
              >
                {option.icon}
                {t(`blockType.${option.labelKey}`)}
                <MenuShortcut keys={option.keys} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RichTextListToggles({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  return (
    <RichTextToolbarGroup label={t('lists')}>
      <RichTextToggle
        label={t('bulletList')}
        shortcut={["mod", "shift", "8"]}
        pressed={state.bulletList}
        disabled={!state.editable}
        onToggle={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <ListIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('numberedList')}
        shortcut={["mod", "shift", "7"]}
        pressed={state.orderedList}
        disabled={!state.editable}
        onToggle={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrderedIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('taskList')}
        shortcut={["mod", "shift", "9"]}
        pressed={state.taskList}
        disabled={!state.editable}
        onToggle={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <ListTodoIcon aria-hidden="true" />
      </RichTextToggle>
    </RichTextToolbarGroup>
  )
}

export function RichTextBlockToggles({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  return (
    <RichTextToolbarGroup label={t('blocks')}>
      <RichTextToggle
        label={t('quote')}
        shortcut={["mod", "shift", "B"]}
        pressed={state.blockquote}
        disabled={!state.editable}
        onToggle={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <TextQuoteIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('codeBlock')}
        shortcut={["mod", "alt", "C"]}
        pressed={state.codeBlock}
        disabled={!state.editable}
        onToggle={() => editor?.chain().focus().toggleCodeBlock().run()}
      >
        <SquareCodeIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextButton
        label={t('divider')}
        disabled={!state.editable}
        onClick={() => editor?.chain().focus().setHorizontalRule().run()}
      >
        <MinusIcon aria-hidden="true" />
      </RichTextButton>
    </RichTextToolbarGroup>
  )
}

export function RichTextMarkToggles({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  const disabled = !state.canFormat

  return (
    <RichTextToolbarGroup label={t('textStyle')}>
      <RichTextToggle
        label={t('bold')}
        shortcut={["mod", "B"]}
        pressed={state.bold}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleBold().run()}
      >
        <BoldIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('italic')}
        shortcut={["mod", "I"]}
        pressed={state.italic}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('underline')}
        shortcut={["mod", "U"]}
        pressed={state.underline}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('strikethrough')}
        shortcut={["mod", "shift", "S"]}
        pressed={state.strike}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleStrike().run()}
      >
        <StrikethroughIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label={t('inlineCode')}
        shortcut={["mod", "E"]}
        pressed={state.code}
        disabled={!state.canCode}
        onToggle={() => editor?.chain().focus().toggleCode().run()}
      >
        <CodeIcon aria-hidden="true" />
      </RichTextToggle>
    </RichTextToolbarGroup>
  )
}

const ALIGN_KEYS: Record<RichTextAlign, string> = {
  left: "L",
  center: "E",
  right: "R",
  justify: "J",
}

// Whole static nodes per key, so the trigger can mirror the current value.
const ALIGN_ICONS: Record<RichTextAlign, ReactNode> = {
  left: (
    <AlignLeftIcon aria-hidden="true" />
  ),
  center: (
    <AlignCenterIcon aria-hidden="true" />
  ),
  right: (
    <AlignRightIcon aria-hidden="true" />
  ),
  justify: (
    <AlignJustifyIcon aria-hidden="true" />
  ),
}

const isAlign = (value: unknown): value is RichTextAlign =>
  typeof value === "string" && (RICH_TEXT_ALIGNS as readonly string[]).includes(value)

export function RichTextAlignMenu({ editor, state }: ControlProps) {
  const t = useTranslations('Editor.richText')
  const alignLabel = (align: RichTextAlign) => t(`align.${align}`)
  // Two glyphs and no label read as an icon button, so the text inset is trimmed.
  return (
    <DropdownMenu>
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('alignmentAria', { align: alignLabel(state.align) })}
                disabled={!state.editable}
                className="gap-0.5 px-1.5"
                data-toolbar-item=""
              />
            }
          >
            {ALIGN_ICONS[state.align]}
            <ChevronDownIcon aria-hidden="true" className="opacity-60" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('alignment')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-auto"
        finalFocus={focusEditor(editor)}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('alignment')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.align}
            onValueChange={(value) => {
              if (isAlign(value)) {
                editor?.chain().focus().setTextAlign(value).run()
              }
            }}
          >
            {RICH_TEXT_ALIGNS.map((align) => (
              <DropdownMenuRadioItem key={align} value={align} closeOnClick>
                {ALIGN_ICONS[align]}
                {alignLabel(align)}
                <MenuShortcut keys={["mod", "shift", ALIGN_KEYS[align]]} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}