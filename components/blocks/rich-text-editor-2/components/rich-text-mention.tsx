import type { Ref } from "react"
import { Mention, type MentionNodeAttrs } from "@tiptap/extension-mention"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps } from "@tiptap/suggestion"
import { cn } from "cn"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"

import {
  createRichTextSuggestionRender,
  RichTextSuggestionMenu,
  type RichTextSuggestionHandle,
} from "./rich-text-suggestion"

export interface RichTextMentionCandidate {
  id: string
  label: string
  initials: string
  description?: string
  avatar?: string
}

/** The chip a mention renders as, scoped to .tiptap like the rest of the prose.
 * ProseMirror's unlayered sheet resets atoms to wrap, so nowrap needs the !. */
export const RICH_TEXT_MENTION_PROSE = cn(
  "[&_.tiptap_[data-type=mention]]:bg-primary/10 [&_.tiptap_[data-type=mention]]:text-primary [&_.tiptap_[data-type=mention]]:rounded-sm [&_.tiptap_[data-type=mention]]:px-1 [&_.tiptap_[data-type=mention]]:py-0.5 [&_.tiptap_[data-type=mention]]:font-medium [&_.tiptap_[data-type=mention]]:whitespace-nowrap!"
)

// A picker, not a directory: the closest few names are enough.
const MAX_MATCHES = 6

function matchCandidates(
  candidates: readonly RichTextMentionCandidate[],
  query: string
) {
  const needle = query.trim().toLowerCase()

  return candidates
    .filter(
      (candidate) =>
        !needle ||
        candidate.label
          .toLowerCase()
          .split(/\s+/)
          .some((part) => part.startsWith(needle)) ||
        candidate.label.toLowerCase().startsWith(needle)
    )
    .slice(0, MAX_MATCHES)
}

type MentionMenuProps = SuggestionProps<
  RichTextMentionCandidate,
  MentionNodeAttrs
> & {
  ref?: Ref<RichTextSuggestionHandle>
}

function MentionMenu({
  ref,
  editor,
  items,
  loading,
  command,
}: MentionMenuProps) {
  // The first lookup is still running: nothing to show yet.
  if (loading && items.length === 0) return null

  return (
    <RichTextSuggestionMenu
      ref={ref}
      editor={editor}
      label="Mention a teammate"
      empty="No one by that name"
      groups={[{ heading: "People", items }]}
      getKey={(candidate) => candidate.id}
      onSelect={(candidate) =>
        command({ id: candidate.id, label: candidate.label })
      }
      className="w-64"
      renderItem={(candidate) => (
        <>
          <Avatar size="sm">
            <AvatarImage src={candidate.avatar} alt="" />
            <AvatarFallback>{candidate.initials}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{candidate.label}</span>
            {candidate.description ? (
              <span className="text-muted-foreground truncate text-xs">
                {candidate.description}
              </span>
            ) : null}
          </span>
        </>
      )}
    />
  )
}

export const RICH_TEXT_MENTION_KEY = new PluginKey("richTextMention")

/** "@" mentions of the given people; call it at module scope. */
export function createRichTextMention(
  candidates: readonly RichTextMentionCandidate[]
) {
  return Mention.configure({
    // Backspace removes the whole chip instead of reopening the picker.
    deleteTriggerWithBackspace: true,
    suggestion: {
      char: "@",
      pluginKey: RICH_TEXT_MENTION_KEY,
      // The placeholder already paints .is-empty lines.
      decorationEmptyClass: "is-query-empty",
      items: ({ query }) => matchCandidates(candidates, query),
      render: createRichTextSuggestionRender(MentionMenu),
    },
  })
}