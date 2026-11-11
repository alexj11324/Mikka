// The default search slot (docs/ui-overlay.md): none. ⌘K draws GlobalSearch's own palette
// (components/nav/global-search.tsx); a layer that draws its own exports a component here.
import type { ComponentType } from 'react'
import type { SearchPaletteProps } from './search-contract'

export const SearchPalette: ComponentType<SearchPaletteProps> | null = null
