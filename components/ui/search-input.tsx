"use client"

import * as React from "react"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

/**
 * The one search field (R-31): grey fill, no stroke, icon on the left and a
 * light focus ring, as CommandInput and the top-bar search pill. `className`
 * sizes the field; every other prop goes to the input.
 */
function SearchInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <InputGroup
      data-slot="search-input"
      className={cn(
        "border-transparent bg-control shadow-none dark:bg-control has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:bg-control-hover has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30",
        className
      )}
    >
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput autoComplete="off" {...props} />
    </InputGroup>
  )
}

export { SearchInput }
