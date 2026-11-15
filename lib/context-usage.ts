/**
 * What a task thread's run holds, as far as this host can read it.
 *
 * Every number here is an ESTIMATE from stored text, never a provider
 * tokenizer's count: it will not reconcile with a bill, so `estimated: true`
 * travels on the wire and no screen may present it as a measurement.
 *
 * What this file deliberately does NOT claim, and why:
 * - `windowTokens` is null. No provider context window is stored anywhere in
 *   Mikka (no `contextWindow` on a model, a binding or a run), so there is no
 *   denominator and none is invented.
 * - `compactAtTokens` is null. Only the Coordinator folds older turns
 *   (lib/coordinator/context.ts). A task thread keeps its whole conversation,
 *   so copying that threshold here would describe a limit it does not have.
 * - `system`, `tools`, `mcp` and `environment` are unmeasured, not zero. The
 *   harness CLI owns the system prompt and its tool definitions, and the
 *   daemon assembles the MCP and environment sections
 *   (packages/daemon/src/agents/run-context.ts `instructions()`), so the
 *   server holds no text for them. Counting them as zero would understate.
 * - Skills mounted at claim time are unmeasured for the same reason: the
 *   daemon inlines them from the claim assignment, never into
 *   `agent_runs.prompt`. A skill body already inside the brief is measured,
 *   as part of `rules`.
 */

/**
 * Capy's seven segment keys, reused as they are so a reader who knows one
 * product's breakdown reads the other's the same way.
 */
export const CONTEXT_SEGMENT_KEYS = ['system', 'tools', 'rules', 'skills', 'mcp', 'environment', 'conversation'] as const
export type ContextSegmentKey = typeof CONTEXT_SEGMENT_KEYS[number]

export type ContextSegment = { key: ContextSegmentKey; tokens: number }

export interface ContextUsage {
  /** Always true: a character heuristic, not the provider's tokenizer. */
  estimated: true
  /** Estimated tokens this thread's run holds: the brief plus everything said since. */
  used: number
  /** Measured segments, largest first. They sum to `used`. */
  segments: ContextSegment[]
  /** Segment keys whose text this host cannot read, so they are named instead of counted as 0. */
  unmeasured: ContextSegmentKey[]
  /** Estimated tokens of the brief (the issue task plus the host and standing instructions). */
  promptUsed: number
  /** The brief's enforced cap in the same estimated tokens. It caps the brief only; the conversation after it is not capped. */
  promptBudget: number
  /** The model the run was frozen with, when it recorded one. */
  model: string | null
  /** Frozen selection and the model reported by the current attempt, when recorded. */
  composerModel?: { selected: string | null; served: string | null }
  /** A task thread never folds older turns: there is no threshold to report. */
  compactAtTokens: null
  /** No provider context window is stored, so no share of one is shown. */
  windowTokens: null
}

/** The enforced cap on a run's brief, in characters (lib/run-prompt.ts `runPromptParts`). */
export const PROMPT_MAX_CHARS = 100_000

/** Characters a token is assumed to cover when ASCII; any other character counts as one. */
const ASCII_CHARS_PER_TOKEN = 4

/** Character counts a text adds up to, the only input the estimator needs. */
export interface CharCounts {
  /** Characters below U+0080. */
  ascii: number
  /** Characters at or above U+0080. */
  other: number
}

/**
 * Estimated tokens for a piece of text: about four ASCII characters a token,
 * one for anything else (Chinese runs close to a token a character). The
 * Coordinator's compaction estimate (lib/coordinator/context.ts
 * `estimateTokens`) uses this same rule, so a person sees one heuristic.
 */
export function estimateTokensFromCounts({ ascii, other }: CharCounts): number {
  return Math.ceil(Math.max(0, ascii) / ASCII_CHARS_PER_TOKEN) + Math.max(0, other)
}

/** Counts of one text, in the same terms the SQL side counts rows. */
export function countChars(text: string): CharCounts {
  let ascii = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  }
  return { ascii, other }
}

/** `estimateTokensFromCounts` for one text. */
export function estimateTextTokens(text: string): number {
  return text ? estimateTokensFromCounts(countChars(text)) : 0
}

/** The brief's estimated cap, in the same unit as `promptBudget`. */
export const PROMPT_BUDGET_TOKENS = Math.ceil(PROMPT_MAX_CHARS / ASCII_CHARS_PER_TOKEN)

/**
 * The stored-chunk types whose payload is the text the agent or a tool wrote.
 * Frames that carry no text the model reads back (start/finish, a usage
 * receipt, a run state) are not conversation.
 *
 * A tool's structured *input* is not counted: JSON re-serialised in SQL and in
 * JS differs in whitespace, and a breakdown whose parts disagree by formatting
 * is worse than one that names what it leaves out. Tool output is, and is
 * usually the larger half anyway.
 */
export const CONVERSATION_CHUNK_KEYS = ['delta', 'output', 'errorText'] as const

export const threadModelProjection = `left(latest."agentDefinition"->>'model',200) AS "selectedModel",
    CASE WHEN jsonb_typeof(latest.report#>'{runtime,observedModel}')='string'
        THEN left(latest.report#>>'{runtime,observedModel}',500) END AS "servedModel"`

/**
 * The SQL that counts characters instead of returning them, so a cursor read
 * stays small: the whole point of `chunkCursor` is that a later read does not
 * carry the brief again (tests/thread-detail-bytes.db.test.ts enforces it).
 *
 * It must stay the counting twin of `countChars`: `[^[:ascii:]]` removes
 * exactly the characters `countChars` calls `other`, so what `length` reports
 * for the stripped text is the ASCII count and the difference is the rest.
 *
 * `$1` is the run-id array, `$2` the root run. One round trip returns both the
 * brief's counts and the conversation's; neither row carries any text.
 */
export const CONTEXT_CHARS_SQL = `
  WITH frames AS (
    SELECT chunk->>'delta' AS txt FROM run_chunks WHERE "runId" = ANY($1::uuid[]) AND chunk->>'type' IN ('text-delta','reasoning-delta')
    UNION ALL
    SELECT chunk->>'output' FROM run_chunks WHERE "runId" = ANY($1::uuid[]) AND chunk->>'type' = 'tool-output-available'
    UNION ALL
    SELECT chunk->>'errorText' FROM run_chunks WHERE "runId" = ANY($1::uuid[]) AND chunk->>'type' = 'tool-output-error'
  ), counted AS (
    SELECT coalesce(sum(length(regexp_replace(txt, '[^[:ascii:]]', '', 'g'))),0) AS ascii,
           coalesce(sum(length(txt) - length(regexp_replace(txt, '[^[:ascii:]]', '', 'g'))),0) AS other
    FROM frames WHERE txt IS NOT NULL
  ), spoken AS (
    SELECT coalesce(sum(length(regexp_replace(text, '[^[:ascii:]]', '', 'g'))),0) AS ascii,
           coalesce(sum(length(text) - length(regexp_replace(text, '[^[:ascii:]]', '', 'g'))),0) AS other
    FROM run_messages WHERE "runId" = ANY($1::uuid[])
  ), brief AS (
    SELECT prompt, "agentDefinition"->>'model' AS model,
      -- The same range validTaskRange accepts (lib/run-prompt-copy.ts): two
      -- non-negative integers that fit inside the prompt, else no task at all.
      CASE WHEN "promptTaskStart" IS NOT NULL AND "promptTaskLength" IS NOT NULL
        AND "promptTaskStart" >= 0 AND "promptTaskLength" >= 0
        AND "promptTaskStart" + "promptTaskLength" <= length(prompt)
        THEN substring(prompt FROM "promptTaskStart" + 1 FOR "promptTaskLength") END AS task
    FROM agent_runs WHERE id = $2
  )
  SELECT
    (SELECT ascii FROM counted) AS "conversationAscii",
    (SELECT other FROM counted) AS "conversationOther",
    (SELECT ascii FROM spoken) AS "messageAscii",
    (SELECT other FROM spoken) AS "messageOther",
    length(regexp_replace(brief.prompt, '[^[:ascii:]]', '', 'g')) AS "promptAscii",
    length(brief.prompt) - length(regexp_replace(brief.prompt, '[^[:ascii:]]', '', 'g')) AS "promptOther",
    -- The recorded task, sliced here so its text never leaves the server.
    length(regexp_replace(task, '[^[:ascii:]]', '', 'g')) AS "taskAscii",
    length(task) - length(regexp_replace(task, '[^[:ascii:]]', '', 'g')) AS "taskOther",
    brief.model,
    ${threadModelProjection}
  FROM brief LEFT JOIN agent_runs latest ON latest.id=$3 AND latest.id=ANY($1::uuid[])`

/** Everything about a run this host can read, as counted characters. */
export interface ContextCharSources {
  /** The whole stored brief. */
  prompt: CharCounts
  /** The issue task inside the brief (zero when the stored range does not hold it). */
  task: CharCounts
  /** What people said in the thread. */
  messages: CharCounts
  /** The agent's and its tools' words, counted over the whole run chain. */
  conversation: CharCounts
  /** The model the run was frozen with. */
  model?: string | null
  composerModel?: ContextUsage['composerModel']
}

/**
 * How much a thread's run holds. `conversation` is what the person and the
 * agent said (the issue task included); `rules` is the rest of the brief: the
 * host guidance and the agent's standing instructions.
 */
export function contextUsageFromCounts(sources: ContextCharSources): ContextUsage {
  const promptTokens = estimateTokensFromCounts(sources.prompt)
  // The task sits inside the brief, so it is counted once, as conversation.
  const taskTokens = estimateTokensFromCounts(sources.task)
  const conversationTokens = taskTokens
    + estimateTokensFromCounts(sources.messages)
    + estimateTokensFromCounts(sources.conversation)
  const rulesTokens = Math.max(0, promptTokens - taskTokens)

  const segments = [
    { key: 'conversation' as const, tokens: conversationTokens },
    { key: 'rules' as const, tokens: rulesTokens },
  ].filter(segment => segment.tokens > 0).sort((left, right) => right.tokens - left.tokens)

  return {
    estimated: true,
    used: segments.reduce((total, segment) => total + segment.tokens, 0),
    segments,
    unmeasured: CONTEXT_SEGMENT_KEYS.filter(key => !segments.some(segment => segment.key === key)),
    promptUsed: promptTokens,
    promptBudget: PROMPT_BUDGET_TOKENS,
    model: sources.model ?? null,
    ...(sources.composerModel ? { composerModel: sources.composerModel } : {}),
    compactAtTokens: null,
    windowTokens: null,
  }
}

/** `contextUsageFromCounts` for sources still in text form. */
export function contextUsage(sources: {
  prompt: string
  /** The issue task, already located inside `prompt` by its stored range (lib/thread-prompt.ts); '' when unknown. */
  task: string
  messages: readonly string[]
  chunks: readonly { chunk: Record<string, unknown> }[]
  model?: string | null
  composerModel?: ContextUsage['composerModel']
}): ContextUsage {
  // `task` is attributed to the conversation and never added twice: it is
  // counted once, as part of `prompt` and again as what the person asked.
  return contextUsageFromCounts({
    prompt: countChars(sources.prompt),
    task: countChars(sources.task),
    messages: sumCounts(sources.messages.map(countChars)),
    conversation: sumCounts(sources.chunks.map(({ chunk }) => countChars(chunkText(chunk) ?? ''))),
    model: sources.model,
    composerModel: sources.composerModel,
  })
}

function sumCounts(values: readonly CharCounts[]): CharCounts {
  return values.reduce((total, value) => ({ ascii: total.ascii + value.ascii, other: total.other + value.other }), { ascii: 0, other: 0 })
}

/** The text one stored chunk adds to the conversation, or '' for a frame carrying none. */
export function chunkText(chunk: Record<string, unknown>): string {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.delta === 'string' ? chunk.delta : ''
    case 'tool-output-available':
      return typeof chunk.output === 'string' ? chunk.output : ''
    case 'tool-output-error':
      return typeof chunk.errorText === 'string' ? chunk.errorText : ''
    default:
      return ''
  }
}
