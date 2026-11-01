import type { ReactNode } from 'react'
import type { ImageProps } from '@expo/ui/swift-ui'

export type SymbolName = NonNullable<ImageProps['systemName']>

/** The web build's stand-in for an SF Symbol (Symbol.ios.tsx draws the symbol on iOS). */
export function Symbol({ web }: { name: SymbolName; size?: number; color?: string; web?: ReactNode }) {
  return <>{web ?? null}</>
}
