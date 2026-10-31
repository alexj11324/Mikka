'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import type { ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'

const tint = (token: string) => `color-mix(in oklch, var(--${token}) 10%, transparent)`
// OpenUI picks series from the middle of the palette outwards, so --chart-1 sits in the middle: one series is blue.
const palette = [4, 2, 1, 3, 5].map(index => `var(--chart-${index})`)

/**
 * OpenUI's own theme keys, pointed at the app's tokens: surfaces, text, fonts,
 * radius, accent, status (the StatusBadge set, R-34) and the chart colours.
 * The tokens switch with `.dark`, so one theme serves both modes; `mode`
 * picks OpenUI's own dark defaults for the keys left unmapped.
 */
const agentTheme = createTheme({
  background: 'var(--background)',
  foreground: 'var(--card)',
  popoverBackground: 'var(--popover)',
  sunkLight: 'var(--muted)',
  sunk: 'var(--muted)',
  sunkDeep: 'var(--control)',
  highlightSubtle: 'var(--control)',
  highlight: 'var(--accent)',
  highlightStrong: 'var(--control-hover)',
  textNeutralPrimary: 'var(--foreground)',
  textNeutralSecondary: 'var(--muted-foreground)',
  textNeutralTertiary: 'var(--muted-foreground)',
  textNeutralLink: 'var(--primary)',
  textAccentPrimary: 'var(--primary-foreground)',
  interactiveAccentDefault: 'var(--primary)',
  interactiveAccentHover: 'var(--primary)',
  interactiveAccentPressed: 'var(--primary)',
  interactiveAccentDisabled: 'var(--muted)',
  interactiveDestructiveDefault: 'var(--destructive)',
  interactiveDestructiveHover: 'var(--destructive)',
  interactiveDestructivePressed: 'var(--destructive)',
  borderDefault: 'var(--border)',
  borderInteractive: 'transparent',
  borderInteractiveEmphasis: 'var(--ring)',
  borderInteractiveSelected: 'var(--ring)',
  borderAccent: 'var(--primary)',
  infoBackground: tint('info'),
  successBackground: tint('success'),
  alertBackground: tint('warning'),
  dangerBackground: tint('destructive'),
  textInfoPrimary: 'var(--info-foreground)',
  textSuccessPrimary: 'var(--success-foreground)',
  textAlertPrimary: 'var(--warning-foreground)',
  textDangerPrimary: 'var(--destructive)',
  borderInfo: 'transparent',
  borderSuccess: 'transparent',
  borderAlert: 'transparent',
  borderDanger: 'transparent',
  defaultChartPalette: palette,
  radiusXs: 'var(--radius-sm)',
  radiusS: '0.375rem',
  radiusM: '0.5rem',
  radiusL: '0.75rem',
  radiusXl: '0.75rem',
  radius2xl: '0.875rem',
  fontBody: 'var(--font-sans)',
  fontHeading: 'var(--font-sans)',
  fontLabel: 'var(--font-sans)',
  fontNumbers: 'var(--font-sans)',
  fontCode: 'var(--font-mono)',
})

/** Themes OpenUI's own components inside any `.mikka-agent` conversation. */
export function AgentThemeProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme()
  return <ThemeProvider cssSelector=".mikka-agent" mode={resolvedTheme === 'dark' ? 'dark' : 'light'} lightTheme={agentTheme} darkTheme={agentTheme}>{children}</ThemeProvider>
}
