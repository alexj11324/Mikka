// Relay envelopes for `GET /v1/stream` (ADR 0002). Daemons publish in-flight
// run events; desktop clients subscribe by run id. The server assigns `seq`
// per run, keeps a bounded ring buffer for late subscribers, and persists
// `message.final` as a `message` row, so the relay is never the system of
// record. Every envelope carries `v`; unknown versions are refused.
// Message content is AI SDK UIMessage / UIMessageChunk (see `runEvent`).
import {
  asSchema,
  safeValidateUIMessages,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { z } from "zod"

export const RELAY_PROTOCOL_VERSION = 1
/** Longest message a person can send to a running agent, in characters. */
export const MAX_INPUT_LENGTH = 20_000
export const RELAY_PATH = "/v1/stream"
/** JWT for the relay handshake (browsers cannot set WebSocket headers). */
export const RELAY_TOKEN_PARAM = "token"

/**
 * Presence (ADR 0049): how often a client re-announces where it is looking,
 * and how long the server keeps an announcement after the last one. The
 * timeout also covers the moment between a socket closing (a token refresh
 * closes it with 4401) and the client reconnecting, so members do not blink.
 */
export const PRESENCE_HEARTBEAT_MS = 20_000
export const PRESENCE_TIMEOUT_MS = 60_000

/** WebSocket close codes the relay uses (4000-4999 are app-defined). */
export const RELAY_CLOSE = {
  unauthorized: 4401,
  updateRequired: 4426,
  rateLimited: 4429,
} as const

const uuid = z.uuid()

/**
 * Run events. Message content uses the Vercel AI SDK's UI message formats
 * (`UIMessageChunk` while streaming, `UIMessage` when final), which AI
 * Elements renders and `useChat` / `readUIMessageStream` assemble, so
 * Mikka defines no message parts of its own. The envelope only checks the
 * shape here; `validateRunEvent` runs the SDK's own validators.
 */
export const runEvent = z.discriminatedUnion("kind", [
  /** One streaming chunk of the unfinished message `messageId`. */
  z.object({
    kind: z.literal("chunk"),
    messageId: uuid,
    chunk: z.looseObject({ type: z.string() }),
  }),
  /** A finished message; persisted as a `message` row, then fanned out. */
  z.object({
    kind: z.literal("message.final"),
    /** Order of the message within the run. */
    seq: z.number().int().min(0),
    message: z.looseObject({
      id: uuid,
      role: z.enum(["system", "user", "assistant"]),
      parts: z.array(z.looseObject({ type: z.string() })),
    }),
  }),
  z.object({
    kind: z.literal("run.status"),
    status: z.enum([
      "queued",
      "preparing",
      "running",
      "waiting_input",
      "finishing",
      "succeeded",
      "failed",
      "cancelled",
    ]),
  }),
])

type RunEventShape = z.infer<typeof runEvent>
export type RunEvent =
  | (Omit<Extract<RunEventShape, { kind: "chunk" }>, "chunk"> & {
      chunk: UIMessageChunk
    })
  | (Omit<Extract<RunEventShape, { kind: "message.final" }>, "message"> & {
      message: UIMessage
    })
  | Extract<RunEventShape, { kind: "run.status" }>

const chunkSchema = asSchema(uiMessageChunkSchema)

/** Validates chunk / message content with the AI SDK's schemas. */
export async function validateRunEvent(
  event: RunEventShape
): Promise<RunEvent | null> {
  if (event.kind === "chunk") {
    const result = await chunkSchema.validate?.(event.chunk)
    return result?.success ? { ...event, chunk: result.value } : null
  }
  if (event.kind === "message.final") {
    const result = await safeValidateUIMessages({ messages: [event.message] })
    return result.success ? { ...event, message: result.data[0]! } : null
  }
  return event
}

const v = z.literal(RELAY_PROTOCOL_VERSION)

/**
 * The page a member is looking at, for presence (ADR 0049). An issue or a
 * project of the workspace they announce in.
 */
export const presenceView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("issue"), id: uuid }),
  z.object({ type: z.literal("project"), id: uuid }),
])
export type PresenceView = z.infer<typeof presenceView>

export const relayClientMessage = z.discriminatedUnion("type", [
  z.object({
    v,
    type: z.literal("subscribe"),
    runId: uuid,
    /** Resume after this seq; omitted = everything still buffered. */
    after: z.number().int().min(0).optional(),
  }),
  z.object({ v, type: z.literal("unsubscribe"), runId: uuid }),
  z.object({ v, type: z.literal("publish"), runId: uuid, event: runEvent }),
  /**
   * A person's message to the running agent (ADR 0018). Saved as a `user`
   * message row with this id (a re-send with the same id is applied once),
   * then handed to the run's daemon, which marks it delivered.
   */
  z.object({
    v,
    type: z.literal("send"),
    runId: uuid,
    messageId: uuid,
    text: z.string().trim().min(1).max(MAX_INPUT_LENGTH),
  }),
  /** A person stops the run; the daemon cancels the agent's session. */
  z.object({ v, type: z.literal("stop"), runId: uuid }),
  /**
   * Says where this connection is looking, in one workspace (ADR 0049). Sent
   * once when a page opens and again every `PRESENCE_HEARTBEAT_MS`; `view`
   * null keeps the member online without naming a page. Never persisted.
   */
  z.object({
    v,
    type: z.literal("presence"),
    workspaceId: uuid,
    view: presenceView.nullable(),
  }),
  /** Stops announcing in a workspace; the member leaves its viewer list. */
  z.object({ v, type: z.literal("presence.leave"), workspaceId: uuid }),
])
export type RelayClientMessage = z.infer<typeof relayClientMessage>

export const RELAY_ERROR_CODES = [
  "bad_message",
  "unauthorized",
  "forbidden",
  "update_required",
  "rate_limited",
  "persist_failed",
  /** `send` / `stop` to a run that is not active (queued or ended). */
  "run_not_active",
  /** `presence` for a workspace the caller is not a member of (ADR 0049). */
  "not_a_member",
] as const
export const relayErrorCode = z.enum(RELAY_ERROR_CODES)
export type RelayErrorCode = z.infer<typeof relayErrorCode>

export const relayServerMessage = z.discriminatedUnion("type", [
  z.object({
    v,
    type: z.literal("subscribed"),
    runId: uuid,
    latestSeq: z.number().int().min(0),
  }),
  z.object({
    v,
    type: z.literal("event"),
    runId: uuid,
    seq: z.number().int().min(1),
    event: runEvent,
  }),
  /**
   * `send` / `stop` was saved and is on its way to the run's device.
   * `messageId` is set for `send`.
   */
  z.object({
    v,
    type: z.literal("accepted"),
    runId: uuid,
    request: z.enum(["send", "stop"]),
    messageId: uuid.optional(),
  }),
  /** Publisher acknowledgment with the seq the hub assigned. */
  z.object({
    v,
    type: z.literal("ack"),
    runId: uuid,
    seq: z.number().int().min(1),
  }),
  /**
   * Everyone the server sees online in this workspace, and where each is
   * looking (ADR 0049). A snapshot after every change, so a client never has
   * to merge deltas; `lastSeenAt` is the server's clock.
   */
  z.object({
    v,
    type: z.literal("presence"),
    workspaceId: uuid,
    members: z.array(
      z.object({
        userId: uuid,
        view: presenceView.nullable(),
        lastSeenAt: z.number().int(),
      })
    ),
  }),
  z.object({
    v,
    type: z.literal("error"),
    code: relayErrorCode,
    message: z.string(),
    runId: uuid.optional(),
    minVersion: z.string().optional(),
  }),
])
type RelayServerShape = z.infer<typeof relayServerMessage>
/** Server frames; `event` content is AI SDK-typed (validated before fan-out). */
export type RelayServerMessage =
  | Exclude<RelayServerShape, { type: "event" }>
  | (Omit<Extract<RelayServerShape, { type: "event" }>, "event"> & {
      event: RunEvent
    })

/** Decodes one frame; null when it is not valid JSON or not an envelope. */
export function decodeRelayClientMessage(
  raw: string
): RelayClientMessage | null {
  try {
    const parsed = relayClientMessage.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function decodeRelayServerMessage(
  raw: string
): RelayServerMessage | null {
  try {
    const parsed = relayServerMessage.safeParse(JSON.parse(raw))
    // The server only fans out events it validated with the AI SDK schemas.
    return parsed.success ? (parsed.data as RelayServerMessage) : null
  } catch {
    return null
  }
}
