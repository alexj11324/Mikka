import { z } from 'zod'
import { taskDestinationSchema, type TaskDestination } from './task-destination'
import { MODEL_ROUTING_EFFORTS } from './model-routing'

/** Slack `@Mikka bot=<alias>`: lowercase so the workspace index is case-insensitive. */
export const BOT_ALIAS_MAX = 32
export const botAliasSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)

/** Where the Bot itself runs: Mikka Cloud (the owner's cloud computer), the Cloudflare coding machine, or one of the owner's devices in a worktree or the linked checkout. */
export const botRunsOnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud'), provider: z.literal('cloudflare').optional() }).strict(),
  z.object({ kind: z.literal('device'), deviceId: z.uuid(), checkout: z.enum(['worktree', 'linked']) }).strict(),
])
export type BotRunsOn = z.infer<typeof botRunsOnSchema>

export const BOT_DEFAULT_AGENTS = ['claude_code', 'codex'] as const
export type BotDefaultAgent = typeof BOT_DEFAULT_AGENTS[number]

/** Every Bot setting a writer may change; undefined leaves it, null clears it. */
export const botSettingsSchema = z.object({
  alias: botAliasSchema.nullable().optional(),
  environmentId: z.uuid().nullable().optional(),
  crewTarget: taskDestinationSchema.nullable().optional(),
  defaultAgent: z.enum(BOT_DEFAULT_AGENTS).nullable().optional(),
  defaultProfileId: z.uuid().nullable().optional(),
  runsOn: botRunsOnSchema.nullable().optional(),
}).strict()
export type BotSettingsInput = z.input<typeof botSettingsSchema>
export type BotSettings = z.infer<typeof botSettingsSchema>

export const botEffortSchema = z.enum(MODEL_ROUTING_EFFORTS)

/** A Bot's dispatch defaults, as stored. */
export interface BotDispatchDefaults {
  crewTarget: TaskDestination | null
  defaultAgent: BotDefaultAgent | null
  defaultProfileId: string | null
  /** The first repository of the Bot's Environment (lib/bot-environment.ts botRepository). */
  repository?: string | null
}

type Harness = BotDefaultAgent
type Place = 'cloud' | { deviceId: string }

/** What a new thread's dispatch already has: from the task (form, schedule, message) or the Bot model's tool call. */
export interface NewThreadRequest {
  place?: Place
  model?: { harness: Harness; model?: string }
  profileId?: string
  agentId?: string
}

/**
 * Precedence for a new thread: the task's own choice, then the Bot's default,
 * then nothing, which leaves the person's own defaults (优先使用的模型, 运行位置)
 * to the dispatcher. Each field falls back on its own. A thread's next run
 * never takes these: it keeps its own place, Agent and profile.
 */
export function withBotDispatchDefaults(request: NewThreadRequest, bot: BotDispatchDefaults | null): NewThreadRequest & { sponsored?: true } {
  if (!bot) return request
  const crew = request.place === undefined ? bot.crewTarget ?? undefined : undefined
  const place: Place | undefined = request.place ?? (crew ? (crew.kind === 'cloud' ? 'cloud' : { deviceId: crew.deviceId }) : undefined)
  const agentId = request.agentId ?? (crew?.kind === 'device' ? crew.agentId : undefined)
  // A named Agent fixes the harness itself; the Bot's default Agent only fills an open choice.
  const model = request.model ?? (agentId || !bot.defaultAgent ? undefined : { harness: bot.defaultAgent })
  const profileId = request.profileId ?? bot.defaultProfileId ?? undefined
  return { ...(place ? { place } : {}), ...(model ? { model } : {}), ...(profileId ? { profileId } : {}), ...(agentId ? { agentId } : {}),
    ...(crew?.kind === 'cloud' && crew.provider === 'cloudflare' ? { sponsored: true as const } : {}) }
}

/** The `bot=<alias>` token in a Slack message, if any. Slack mention markup (`<@U…>`) is ignored. */
export function slackBotAlias(text: string | null | undefined): string | null {
  const match = /(?:^|\s)bot=([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?=\s|$|[.,!?;:])/.exec(text ?? '')
  return match ? match[1].toLowerCase() : null
}

/** The legacy `bots.repository` value as an Environment repository key (lib/project-resources/contracts.ts). */
export function legacyRepositoryKey(repository: string | null | undefined): string | null {
  const value = repository?.trim().toLowerCase().replace(/\.git$/, '')
  if (!value) return null
  const key = value.startsWith('v2/') ? value : /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(value) ? `v2/github.com/${value}` : null
  return key && /^v2\/[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key) && key.split('/').every(part => part !== '.' && part !== '..') ? key : null
}
