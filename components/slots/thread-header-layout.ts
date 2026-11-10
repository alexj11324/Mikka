// The thread header's narrow layout (#1891 review): it follows the column's own
// inline size, never the viewport. A 1440 px window still opens a 320–360 px
// right column, so a `max-sm:` breakpoint never matched there.
//
// HEADER_CONTAINER is the query container; the header and its mode slot are its
// children, because a container query cannot size the container itself. The
// classes live here so a test can compile them with Tailwind and prove the
// variant is real (`@container thread-header (width < 22rem)`), not a string
// that silently generates nothing.

/** The query container the slot wraps around the header. */
export const HEADER_CONTAINER = '@container/thread-header w-full min-w-0 shrink-0'

/** Under 22rem (352 px) the header may wrap onto a second row. */
export const HEADER_NARROW = '@max-[22rem]/thread-header:h-auto @max-[22rem]/thread-header:flex-wrap @max-[22rem]/thread-header:py-2'

/** Under 22rem the mode control takes that second row, full width. */
export const MODE_SLOT_NARROW = '@max-[22rem]/thread-header:order-last @max-[22rem]/thread-header:w-full'
