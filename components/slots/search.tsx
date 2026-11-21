import type { SearchPaletteProps } from './search-contract'

/** Public build-time contract. The official renderer links the provider. */
export function SearchPalette(_props: SearchPaletteProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: search')
}
