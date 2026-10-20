import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react"
import { ReactRenderer, type Editor } from "@tiptap/react"
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion"
import { cn } from "cn"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

import { keepEditorFocus } from "./rich-text-toolbar"

/** What the editor calls while a suggestion list is open. */
export interface RichTextSuggestionHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

export interface RichTextSuggestionGroup<T> {
  heading: string
  items: T[]
}

// The list owns these keys while open; everything else keeps typing the query.
const LIST_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter"])

// The caret stays in the text, so the editor carries the combobox wiring.
const EDITOR_ARIA = [
  "aria-haspopup",
  "aria-autocomplete",
  "aria-controls",
  "aria-activedescendant",
] as const

interface RichTextSuggestionMenuProps<T> {
  ref?: Ref<RichTextSuggestionHandle>
  editor: Editor
  label: string
  empty: string
  groups: RichTextSuggestionGroup<T>[]
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  onSelect: (item: T) => void
  className?: string
}

/** A caret-anchored listbox on the shadcn Command, driven by the editor's keys. */
export function RichTextSuggestionMenu<T>({
  ref,
  editor,
  label,
  empty,
  groups,
  getKey,
  renderItem,
  onSelect,
  className,
}: RichTextSuggestionMenuProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null)
  const keys = groups.flatMap((group) => group.items.map(getKey))
  const signature = keys.join("\n")
  const [value, setValue] = useState(keys[0] ?? "")
  const [shown, setShown] = useState(signature)

  // A new query restarts the highlight at the first match.
  if (shown !== signature) {
    setShown(signature)
    setValue(keys[0] ?? "")
  }

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown(event) {
        if (!LIST_KEYS.has(event.key) || keys.length === 0) return false

        // Command listens on its root, so the key is replayed there.
        rootRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key,
            bubbles: true,
            cancelable: true,
          })
        )
        return true
      },
    }),
    [keys.length]
  )

  useEffect(() => {
    const dom = editor.view.dom
    // Command marks the active option after this commit, so read it a task later.
    const timer = window.setTimeout(() => {
      const list = rootRef.current?.querySelector("[cmdk-list]")
      const active = list?.querySelector('[aria-selected="true"]')?.id

      dom.setAttribute("aria-haspopup", "listbox")
      dom.setAttribute("aria-autocomplete", "list")
      if (list?.id) dom.setAttribute("aria-controls", list.id)
      if (active) dom.setAttribute("aria-activedescendant", active)
      else dom.removeAttribute("aria-activedescendant")
    })

    return () => window.clearTimeout(timer)
  })

  useEffect(
    () => () => {
      for (const name of EDITOR_ARIA) editor.view.dom.removeAttribute(name)
    },
    [editor]
  )

  return (
    <Command
      ref={rootRef}
      value={value}
      onValueChange={setValue}
      shouldFilter={false}
      loop
      onMouseDown={keepEditorFocus}
      className={cn("ring-foreground/10 w-72 ring-1", className)}
    >
      {/* The list ships its bar hidden; the fade marks the cut-off rows. A short
          reveal keeps it full when the list overflows by only a row or two. */}
      <CommandList
        label={label}
        className="supports-[animation-timeline:scroll()]:scroll-fade-y [--scroll-fade-reveal:--spacing(6)]"
      >
        <CommandEmpty>{empty}</CommandEmpty>
        {groups.map((group) =>
          group.items.length ? (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                // A translucent highlight, so the row's tile still reads on it.
                <CommandItem
                  key={getKey(item)}
                  value={getKey(item)}
                  onSelect={() => onSelect(item)}
                  className="data-selected:bg-input/50"
                >
                  {renderItem(item)}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null
        )}
      </CommandList>
    </Command>
  )
}

type SuggestionListProps<I, S> = SuggestionProps<I, S> & {
  ref?: Ref<RichTextSuggestionHandle>
}

/** Mounts a list at the caret for one Suggestion plugin and tears it down on exit. */
export function createRichTextSuggestionRender<I, S>(
  List: ComponentType<SuggestionListProps<I, S>>
): NonNullable<SuggestionOptions<I, S>["render"]> {
  return () => {
    let renderer: ReactRenderer<
      RichTextSuggestionHandle,
      SuggestionListProps<I, S>
    > | null = null
    let unmount: (() => void) | null = null

    return {
      onStart: (props) => {
        renderer = new ReactRenderer(List, {
          editor: props.editor,
          props,
          className: "z-50",
        })
        unmount = props.mount(renderer.element)
      },
      // A lookup in flight resends the stale list; wait for its result.
      onUpdate: (props) => {
        if (!props.loading) renderer?.updateProps(props)
      },
      onKeyDown: ({ event }) =>
        event.isComposing ? false : (renderer?.ref?.onKeyDown(event) ?? false),
      onExit: () => {
        unmount?.()
        unmount = null
        renderer?.destroy()
        renderer = null
      },
    }
  }
}