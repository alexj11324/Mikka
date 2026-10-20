import {
  mergeAttributes,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  scrollToRichTextHeading,
  useRichTextOutline,
} from "./rich-text-outline"
import type { RichTextSlashItem } from "./rich-text-slash-menu"
import { TableOfContentsIcon } from "lucide-react"

const LINK_INDENT = ["", "ps-4", "ps-8"] as const

function OutlineBlockView({ editor }: ReactNodeViewProps) {
  // Heading edits elsewhere never reach this node, so it reads the editor.
  const outline = useRichTextOutline(editor)

  return (
    <NodeViewWrapper className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs font-medium">Contents</p>
      {outline.length ? (
        <nav aria-label="Contents" className="flex flex-col items-start">
          {outline.map((entry, index) => (
            <Button
              key={entry.id}
              variant="link"
              size="sm"
              onClick={() => scrollToRichTextHeading(editor, index)}
              className={cn(
                "text-muted-foreground hover:text-foreground h-auto max-w-full px-0 py-0.5 font-normal",
                LINK_INDENT[entry.depth]
              )}
            >
              <span className="truncate">{entry.text}</span>
            </Button>
          ))}
        </nav>
      ) : (
        <p className="text-muted-foreground text-sm">
          No headings yet. Add one and it shows up here.
        </p>
      )}
    </NodeViewWrapper>
  )
}

/** A block that lists the page's headings as jump links, kept live as they change. */
export const RichTextOutlineBlock = Node.create({
  name: "richTextOutline",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'nav[data-type="rich-text-outline"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "nav",
      mergeAttributes(HTMLAttributes, { "data-type": "rich-text-outline" }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(OutlineBlockView, {
      // A press on a link jumps; anywhere else it selects the block.
      stopEvent: ({ event }) =>
        event.target instanceof Element &&
        event.target.closest("button") !== null,
    })
  },
})

export const RICH_TEXT_OUTLINE_SLASH_ITEM: RichTextSlashItem = {
  id: "outline",
  group: "Advanced",
  title: "Contents",
  hint: "Jump links to every heading",
  keywords: ["outline", "toc", "headings", "summary"],
  icon: (
    <TableOfContentsIcon aria-hidden="true" />
  ),
  can: (editor) => !editor.isActive("table"),
  run: (editor, range) =>
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent({ type: "richTextOutline" })
      .run(),
}