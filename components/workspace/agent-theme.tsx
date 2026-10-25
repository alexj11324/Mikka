'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import type { ReactNode } from 'react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'

const agentTheme = createTheme({
  background: 'var(--background)',
  foreground: 'var(--background)',
  sunk: 'var(--muted)',
  highlightSubtle: 'var(--background)',
  highlight: 'var(--accent)',
  textNeutralPrimary: 'var(--foreground)',
  textNeutralSecondary: 'var(--muted-foreground)',
  textNeutralTertiary: 'var(--muted-foreground)',
  textAccentPrimary: 'var(--primary-foreground)',
  interactiveAccentDefault: 'var(--primary)',
  interactiveAccentHover: 'var(--primary)',
  interactiveAccentDisabled: 'var(--muted)',
  borderDefault: 'var(--border)',
  borderInteractive: 'var(--input)',
  borderInteractiveEmphasis: 'var(--ring)',
  borderAccent: 'var(--primary)',
  fontBody: 'var(--font-sans)',
  fontHeading: 'var(--font-sans)',
  fontLabel: 'var(--font-sans)',
})

/** Themes OpenUI's own components inside any `.mikka-agent` conversation. */
export function AgentThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeProvider cssSelector=".mikka-agent" lightTheme={agentTheme} darkTheme={agentTheme}>{children}</ThemeProvider>
}
