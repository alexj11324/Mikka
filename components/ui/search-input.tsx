"use client"

import * as React from "react"
import { Search } from "@/components/icons"
import { cn } from "cn"

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

/**
 * The one search field (R-31): the `--control` fill, no stroke, the magnifier on
 * the left and a light focus ring, as CommandInput and the top-bar search pill.
 * It takes the small step of the height scale (R-99) so a search and the
 * `size="sm"` controls beside it line up by construction; a call site that puts
 * it in a row of another step names that step, which is how R-99 sets the step
 * for a control with no `size` prop. `className` sizes the field; every other
 * prop goes to the input.
 */
function SearchInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <InputGroup
      data-slot="search-input"
      className={cn(
        "h-(--control-sm) rounded-[min(var(--radius-md),12px)] border-transparent bg-control shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:bg-control-hover has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/40",
        className
      )}
    >
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput autoComplete="off" {...props} />
    </InputGroup>
  )
}

export { SearchInput }
