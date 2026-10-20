import type { ReactNode, Ref } from "react"
import { IconTile } from "@/components/reui/icon-tile"
import { PluginKey } from "@tiptap/pm/state"
import { Extension, type Editor, type Range } from "@tiptap/react"
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion"

import { CommandShortcut } from "@/components/ui/command"
import {
  createRichTextSuggestionRender,
  RichTextSuggestionMenu,
  type RichTextSuggestionGroup,
  type RichTextSuggestionHandle,
} from "./rich-text-suggestion"
import { TypeIcon, Heading1Icon, Heading2Icon, Heading3Icon, ListIcon, ListOrderedIcon, ListTodoIcon, TextQuoteIcon, SquareCodeIcon, MinusIcon } from "lucide-react"

export interface RichTextSlashItem {
  id: string
  group: string
  title: string
  /** One line under the title: what the block is for. */
  hint: string
  keywords: readonly string[]
  /** The Markdown that makes the same block, where one exists. */
  markdown?: string
  icon: ReactNode
  /** Hides the item where the command would be refused (headings in lists). */
  can: (editor: Editor) => boolean
  /** Runs after the typed "/query" range is removed. */
  run: (editor: Editor, range: Range) => void
}

const BASIC = "Basic Blocks"

export const RICH_TEXT_BASIC_SLASH_ITEMS: RichTextSlashItem[] = [
  {
    id: "text",
    group: BASIC,
    title: "Text",
    hint: "Plain paragraph",
    keywords: ["paragraph", "plain"],
    icon: (
      <TypeIcon aria-hidden="true" />
    ),
    // Already a paragraph counts too, so the item never vanishes mid-query.
    can: (editor) =>
      editor.isActive("paragraph") || editor.can().setParagraph(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "heading-1",
    group: BASIC,
    title: "Heading 1",
    hint: "Large section heading",
    keywords: ["h1", "title", "heading"],
    markdown: "#",
    icon: (
      <Heading1Icon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setHeading({ level: 1 }),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    id: "heading-2",
    group: BASIC,
    title: "Heading 2",
    hint: "Medium section heading",
    keywords: ["h2", "subtitle", "heading"],
    markdown: "##",
    icon: (
      <Heading2Icon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setHeading({ level: 2 }),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    id: "heading-3",
    group: BASIC,
    title: "Heading 3",
    hint: "Small section heading",
    keywords: ["h3", "heading"],
    markdown: "###",
    icon: (
      <Heading3Icon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setHeading({ level: 3 }),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    id: "bullet-list",
    group: BASIC,
    title: "Bullet List",
    hint: "Unordered points",
    keywords: ["unordered", "list", "ul"],
    markdown: "-",
    icon: (
      <ListIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().toggleBulletList(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    group: BASIC,
    title: "Numbered List",
    hint: "Ordered steps",
    keywords: ["ordered", "list", "ol", "steps"],
    markdown: "1.",
    icon: (
      <ListOrderedIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().toggleOrderedList(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "task-list",
    group: BASIC,
    title: "To-do List",
    hint: "Track tasks with checkboxes",
    keywords: ["todo", "task", "checkbox", "check"],
    markdown: "[ ]",
    icon: (
      <ListTodoIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().toggleTaskList(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "quote",
    group: BASIC,
    title: "Quote",
    hint: "Set a passage apart",
    keywords: ["blockquote", "citation"],
    markdown: ">",
    icon: (
      <TextQuoteIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setBlockquote(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setBlockquote().run(),
  },
  {
    id: "code-block",
    group: BASIC,
    title: "Code Block",
    hint: "Monospaced snippet or command",
    keywords: ["code", "snippet", "pre"],
    markdown: "```",
    icon: (
      <SquareCodeIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setCodeBlock(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    id: "divider",
    group: BASIC,
    title: "Divider",
    hint: "A line between sections",
    keywords: ["separator", "rule", "hr", "line"],
    markdown: "---",
    icon: (
      <MinusIcon aria-hidden="true" />
    ),
    can: (editor) => editor.can().setHorizontalRule(),
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
]

function matches(item: RichTextSlashItem, query: string) {
  if (!query) return true

  return (
    item.title.toLowerCase().includes(query) ||
    item.keywords.some((keyword) => keyword.startsWith(query))
  )
}

function groupItems(items: RichTextSlashItem[]) {
  const groups: RichTextSuggestionGroup<RichTextSlashItem>[] = []

  for (const item of items) {
    const group = groups.find((entry) => entry.heading === item.group)

    if (group) group.items.push(item)
    else groups.push({ heading: item.group, items: [item] })
  }

  return groups
}

type SlashMenuProps = SuggestionProps<RichTextSlashItem, RichTextSlashItem> & {
  ref?: Ref<RichTextSuggestionHandle>
}

function SlashMenu({ ref, editor, items, loading, command }: SlashMenuProps) {
  // The first lookup is still running: nothing to show yet.
  if (loading && items.length === 0) return null

  return (
    <RichTextSuggestionMenu
      ref={ref}
      editor={editor}
      label="Insert block"
      empty="No matching blocks"
      groups={groupItems(items)}
      getKey={(item) => item.id}
      onSelect={command}
      renderItem={(item) => (
        <>
          <IconTile variant="elevated" size="sm">
            {item.icon}
          </IconTile>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{item.title}</span>
            <span className="text-muted-foreground truncate text-xs">
              {item.hint}
            </span>
          </span>
          {item.markdown ? (
            <CommandShortcut>{item.markdown}</CommandShortcut>
          ) : null}
        </>
      )}
    />
  )
}

export const RICH_TEXT_SLASH_KEY = new PluginKey("richTextSlash")

interface RichTextSlashOptions {
  items: readonly RichTextSlashItem[]
}

/** "/" opens a block picker at the caret; items come from configure({ items }). */
export const RichTextSlashCommand = Extension.create<RichTextSlashOptions>({
  name: "richTextSlash",
  // Above StarterKit's 100, so Enter picks a command before a list item splits.
  priority: 200,

  addOptions() {
    return { items: [] }
  },

  addProseMirrorPlugins() {
    const { items } = this.options

    return [
      Suggestion<RichTextSlashItem, RichTextSlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: RICH_TEXT_SLASH_KEY,
        // The placeholder already paints .is-empty lines.
        decorationEmptyClass: "is-query-empty",
        allow: ({ state, range }) =>
          !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query, editor }) => {
          const needle = query.trim().toLowerCase()
          return items.filter(
            (item) => matches(item, needle) && item.can(editor)
          )
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: createRichTextSuggestionRender(SlashMenu),
      }),
    ]
  },
})