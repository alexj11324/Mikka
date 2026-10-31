import type { ReactNode } from 'react'

/** The web build's stand-in for an SF Symbol (Symbol.ios.tsx draws the symbol on iOS). */
export function Symbol({ web }: { name: string; size?: number; color?: string; web?: ReactNode }) {
  return <>{web ?? null}</>
}
