import { Bot, Hammer, Network, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { AgentRole } from '@/lib/agent-roles'

export const ROLE_ICONS: Record<AgentRole, LucideIcon> = { coordinator: Network, worker: Hammer, reviewer: ShieldCheck, custom: Bot }
