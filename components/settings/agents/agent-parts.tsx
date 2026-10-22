'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/reui/badge'
import { SoftAvatar, SoftAvatarFallback } from '@/components/ui/soft-avatar'
import { ClaudeCode } from '@/components/ui/svgs/claude-code'
import { Codex } from '@/components/ui/svgs/codex'
import type { AgentStatus } from '@/app/actions/agents'
import type { SupportedHarness } from '@/lib/db/schema'
import { agentColorFor, isBuiltInAgentRole, type AgentColor, type AgentRole } from '@/lib/agent-roles'
import { cn } from '@/lib/utils'
import { agentGlyph, AVATAR_TINTS, ROLE_AVATAR_COLORS, STATUS_DOTS } from './agent-icons'

export function AgentGlyph({ role, icon }: { role: AgentRole; icon: string | null }) {
  const glyph = agentGlyph(role, icon)
  return 'icon' in glyph ? <glyph.icon aria-hidden="true" /> : <span className="text-lg leading-none" aria-hidden="true">{glyph.emoji}</span>
}

/**
 * A role's avatar: a soft-tinted circle with its icon or emoji. Built-in
 * roles keep their fixed tint until the person picks a colour.
 */
export function AgentAvatar({ role, name, icon, color, size = 'row' }: {
  role: AgentRole
  name: string
  icon: string | null
  color: AgentColor | null
  /** preview: the picker footer; row: a list row; header: the detail page. */
  size?: 'preview' | 'row' | 'header'
}) {
  const builtInTint = isBuiltInAgentRole(role) && !color ? ROLE_AVATAR_COLORS[role] : null
  return <SoftAvatar size={size === 'header' ? 'lg' : 'sm'} className={cn(size === 'preview' && 'size-7', size === 'row' && 'size-9', size === 'header' && 'size-11')}>
    <SoftAvatarFallback color={builtInTint ?? undefined} className={cn(!builtInTint && AVATAR_TINTS[agentColorFor(name, color)])}>
      <AgentGlyph role={role} icon={icon} />
    </SoftAvatarFallback>
  </SoftAvatar>
}

const STATUS_VARIANT = {
  running: 'success-light',
  idle: 'outline',
  waiting: 'warning-light',
  offline: 'destructive-light',
} as const

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const t = useTranslations('Agents.status')
  return <Badge variant={STATUS_VARIANT[status]} radius="full" className="gap-1.5 px-2">
    <span className={cn('size-1.5 rounded-full', STATUS_DOTS[status])} aria-hidden="true" />
    {t(status)}
  </Badge>
}

export const HARNESS_LABELS: Record<SupportedHarness, string> = { claude_code: 'Claude Code', codex: 'Codex' }

export function HarnessIcon({ harness, size = 'sm' }: { harness: SupportedHarness; size?: 'sm' | 'md' }) {
  return harness === 'codex'
    ? <Codex className={cn('rounded-xs', size === 'md' ? 'size-4' : 'size-3.5')} />
    : <ClaudeCode className={cn(size === 'md' ? 'size-4' : 'size-3.5')} />
}
