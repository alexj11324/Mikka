'use client'

import type { ComponentType, ReactNode, SVGProps } from 'react'
import { Box, Cloud, Laptop, Monitor, Server, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { modelProvider, type DeviceKind, type ModelProvider } from '@/lib/execution-settings-view'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { ClaudeCodeMark, ClaudeMark, CodexMark, CursorMark, OpenAIMark } from './brand-marks'

/*
 * R-74 shared labels: wherever a device, coding agent (harness) or model is
 * named, its icon comes first, then the name. Build rows, triggers and menu
 * items from these instead of drawing icon + text by hand.
 */

type Mark = ComponentType<SVGProps<SVGSVGElement>> | LucideIcon

function EntityLabel({ icon: Icon, children, muted }: { icon: Mark; children: ReactNode; muted?: boolean }) {
  return <span className={cn('inline-flex min-w-0 items-center gap-1.5', muted && 'text-muted-foreground')}>
    <Icon aria-hidden="true" className="size-4 shrink-0" />
    {children}
  </span>
}

const DEVICE_ICONS: Record<DeviceKind, LucideIcon> = { laptop: Laptop, server: Server, cloud: Cloud, unknown: Monitor }

/**
 * A device: its type (laptop, server, Mikka Cloud), the online dot, then its name.
 * Mikka Cloud is always available, so it has no dot.
 */
export function DeviceLabel({ kind, name, online }: { kind: DeviceKind; name: string; online: boolean }) {
  const t = useTranslations('Settings.botAgents')
  return <EntityLabel icon={DEVICE_ICONS[kind]} muted={!online}>
    {kind !== 'cloud' && <span aria-hidden="true" className={cn('-ml-0.5 size-1.5 shrink-0 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/50')} />}
    <span className="truncate">{name}</span>
    {kind !== 'cloud' && <span className="sr-only">{online ? t('online') : t('offline')}</span>}
  </EntityLabel>
}

const HARNESS_MARKS: Record<string, Mark> = { claude_code: ClaudeCodeMark, codex: CodexMark, cursor: CursorMark }
const HARNESS_NAMES: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness
}

/** A coding agent's mark alone, named for screen readers, where a row lists several (R-74). */
export function HarnessMark({ harness }: { harness: string }) {
  const Icon = HARNESS_MARKS[harness] ?? Box
  return <span role="img" aria-label={harnessName(harness)} className="inline-flex"><Icon aria-hidden="true" className="size-3.5 shrink-0" /></span>
}

/** A coding agent: its own coloured brand mark, then its product name. */
export function HarnessLabel({ harness }: { harness: string }) {
  return <EntityLabel icon={HARNESS_MARKS[harness] ?? Box}><span className="truncate">{harnessName(harness)}</span></EntityLabel>
}

const PROVIDER_MARKS: Record<ModelProvider, Mark> = { claude: ClaudeMark, openai: OpenAIMark, unknown: Box }

/** A provider's mark on its own, as in a list heading; `small` matches heading text. */
export function ProviderMark({ provider, small }: { provider: ModelProvider; small?: boolean }) {
  const Icon = PROVIDER_MARKS[provider]
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', small && 'size-3.5')} />
}

/** A model: its provider's mark, read from the id or the account it came through, then the id. */
/** Mikka's hosted model (Mikka 默认), marked with the small Mikka mark in the model icon's box. */
export function HostedModelLabel({ name }: { name: string }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5">
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center"><MikkaMarkSmall /></span>
    <span className="truncate">{name}</span>
  </span>
}

export function ModelLabel({ model, source }: { model: string; source?: string | null }) {
  return <EntityLabel icon={PROVIDER_MARKS[modelProvider(model, source)]}><span className="truncate">{model}</span></EntityLabel>
}
