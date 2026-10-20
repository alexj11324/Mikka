import type { ReactNode } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PencilIcon, MessageSquareTextIcon, EyeIcon } from "lucide-react"

export type EditorMode = "editing" | "suggesting" | "viewing"

interface ModeOption {
  value: EditorMode
  label: string
  description: string
  icon: ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "editing",
    label: "Editing",
    description: "Edits apply directly",
    icon: (
      <PencilIcon aria-hidden="true" />
    ),
  },
  {
    value: "suggesting",
    label: "Suggesting",
    description: "Text edits become suggestions",
    icon: (
      <MessageSquareTextIcon aria-hidden="true" />
    ),
  },
  {
    value: "viewing",
    label: "Viewing",
    description: "Read only, no edits",
    icon: (
      <EyeIcon aria-hidden="true" />
    ),
  },
]

function isEditorMode(value: unknown): value is EditorMode {
  return MODE_OPTIONS.some((option) => option.value === value)
}

const MODE_ITEMS = MODE_OPTIONS.map(({ value, label }) => ({ value, label }))

const MODE_TRIGGER = Object.fromEntries(
  MODE_OPTIONS.map((option) => [
    option.value,
    <>
      {option.icon}
      <span className="max-sm:sr-only">{option.label}</span>
    </>,
  ])
)

interface ModeSelectProps {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
}

/** Editing, Suggesting or Viewing: how the next edit lands. */
export function ModeSelect({ mode, onModeChange }: ModeSelectProps) {
  return (
    <Select
      items={MODE_ITEMS}
      value={mode}
      onValueChange={(next) => {
        if (isEditorMode(next)) onModeChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Document mode">
        <SelectValue>{MODE_TRIGGER[mode]}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="min-w-60"
      >
        <SelectGroup>
          {MODE_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="items-start"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="text-muted-foreground flex h-5 shrink-0 items-center">
                  {option.icon}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {option.description}
                  </span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}