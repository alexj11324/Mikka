// The apps' relay connection (`GET /v1/stream`, ADR 0002 / ADR 0018):
// one WebSocket to the API server for every run the app watches. It
// subscribes by run id, resumes after the last seq it saw when the socket
// comes back, and carries the member's chat messages and stop requests to
// the run. A message keeps its id across reconnects, so a re-send is saved
// once on the server.
//
// Framework-free so it can be tested with a fake WebSocket; each app wraps it
// for React (desktop `lib/run-chat.ts`, phone `src/backend/RunChat.ts`).
import {
  PRESENCE_HEARTBEAT_MS,
  RELAY_CLOSE,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOKEN_PARAM,
  decodeRelayServerMessage,
  type PresenceView,
  type RelayClientMessage,
  type RelayErrorCode,
  type RelayServerMessage,
  type RunEvent,
} from "@mikka/protocol/relay"
import {
  CLIENT_KIND_PARAM,
  CLIENT_VERSION_PARAM,
  type ClientKind,
} from "@mikka/protocol/version"

export type RelayStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  /** The server refuses this app version (close 4426); no more retries. */
  | "update_required"

export type RunEventListener = (event: RunEvent, seq: number) => void

/** One member the server sees online in a workspace (ADR 0049). */
export type PresenceMember = Extract<
  RelayServerMessage,
  { type: "presence" }
>["members"][number]

export type PresenceListener = (members: readonly PresenceMember[]) => void

/** A `send` or `stop` the server refused. */
export class RelayRequestError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string
  ) {
    super(message)
    this.name = "RelayRequestError"
  }
}

export interface RelayClientOptions {
  /** API server origin. */
  serverUrl: string
  clientVersion: string
  /**
   * Which version series `clientVersion` belongs to. Left out by the desktop,
   * whose series is the server's default; the phone sends `mobile` so it meets
   * the phone's own floor (ADR 0011).
   */
  clientKind?: ClientKind
  /** A fresh short-lived JWT for each (re)connect. */
  getToken: () => Promise<string>
  WebSocket?: typeof WebSocket
  /** Delay before reconnect attempt `n` (from 1). */
  retryDelayMs?: (attempt: number) => number
}

interface Watched {
  listeners: Set<RunEventListener>
  /** Highest seq delivered to listeners; resubscribe resumes after it. */
  lastSeq: number
}

interface Pending {
  frame: Extract<RelayClientMessage, { type: "send" | "stop" }>
  resolve: () => void
  reject: (error: Error) => void
}

const defaultRetry = (attempt: number) =>
  Math.min(500 * 2 ** (attempt - 1), 15_000)

export class RelayClient {
  private ws: WebSocket | null = null
  private status: RelayStatus = "idle"
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A socket is being opened (the token is fetched first); one at a time. */
  private opening = false
  private closedByUs = false
  private readonly runs = new Map<string, Watched>()
  /** Requests not answered yet, in order; re-sent after a reconnect. */
  private readonly pending: Pending[] = []
  /** Where this client says it is looking, per workspace; re-sent on connect. */
  private readonly presence = new Map<string, PresenceView | null>()
  private readonly presenceListeners = new Map<string, Set<PresenceListener>>()
  private readonly presenceSnapshots = new Map<
    string,
    readonly PresenceMember[]
  >()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly statusListeners = new Set<(status: RelayStatus) => void>()
  private readonly WebSocketImpl: typeof WebSocket

  constructor(private readonly options: RelayClientOptions) {
    this.WebSocketImpl = options.WebSocket ?? WebSocket
  }

  getStatus(): RelayStatus {
    return this.status
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Watches a run: buffered events first, then live ones. */
  subscribe(runId: string, listener: RunEventListener): () => void {
    let watched = this.runs.get(runId)
    if (!watched) {
      watched = { listeners: new Set(), lastSeq: 0 }
      this.runs.set(runId, watched)
      this.write({ v: RELAY_PROTOCOL_VERSION, type: "subscribe", runId })
    }
    watched.listeners.add(listener)
    this.connect()
    return () => {
      const current = this.runs.get(runId)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      this.runs.delete(runId)
      this.write({ v: RELAY_PROTOCOL_VERSION, type: "unsubscribe", runId })
    }
  }

  /** Sends the running agent a message; resolves once the server saved it. */
  sendMessage(
    runId: string,
    text: string,
    messageId: string = crypto.randomUUID()
  ): Promise<{ messageId: string }> {
    return this.request({
      v: RELAY_PROTOCOL_VERSION,
      type: "send",
      runId,
      messageId,
      text,
    }).then(() => ({ messageId }))
  }

  /** Asks the run's device to stop the agent. */
  stop(runId: string): Promise<void> {
    return this.request({ v: RELAY_PROTOCOL_VERSION, type: "stop", runId })
  }

  /**
   * Says where this client is looking, in one workspace, and watches who else
   * is there (ADR 0049). The listener gets the last snapshot at once and every
   * later one; the connection opens on the first call and the announcement is
   * repeated as a heartbeat until the last watcher leaves. Nothing is stored:
   * the server forgets the member a timeout after the last announcement.
   */
  watchPresence(
    workspaceId: string,
    view: PresenceView | null,
    listener: PresenceListener
  ): () => void {
    let listeners = this.presenceListeners.get(workspaceId)
    if (!listeners) {
      listeners = new Set()
      this.presenceListeners.set(workspaceId, listeners)
    }
    listeners.add(listener)
    const known = this.presenceSnapshots.get(workspaceId)
    if (known) listener(known)
    this.announce(workspaceId, view)
    return () => {
      const current = this.presenceListeners.get(workspaceId)
      if (!current) return
      current.delete(listener)
      if (current.size > 0) return
      this.presenceListeners.delete(workspaceId)
      this.presenceSnapshots.delete(workspaceId)
      this.presence.delete(workspaceId)
      this.write({
        v: RELAY_PROTOCOL_VERSION,
        type: "presence.leave",
        workspaceId,
      })
      if (this.presence.size === 0) this.stopHeartbeat()
    }
  }

  private announce(workspaceId: string, view: PresenceView | null) {
    this.presence.set(workspaceId, view)
    this.write({
      v: RELAY_PROTOCOL_VERSION,
      type: "presence",
      workspaceId,
      view,
    })
    this.connect()
    this.heartbeat ??= setInterval(() => {
      for (const [id, where] of this.presence)
        this.write({
          v: RELAY_PROTOCOL_VERSION,
          type: "presence",
          workspaceId: id,
          view: where,
        })
    }, PRESENCE_HEARTBEAT_MS)
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  close() {
    this.closedByUs = true
    this.stopHeartbeat()
    clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
    for (const p of this.pending.splice(0))
      p.reject(new Error("The relay connection was closed"))
    this.setStatus("idle")
  }

  private request(frame: Pending["frame"]): Promise<void> {
    if (this.status === "update_required")
      return Promise.reject(
        new RelayRequestError("update_required", "Update Mikka to continue.")
      )
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ frame, resolve, reject })
      this.write(frame)
      this.connect()
    })
  }

  private setStatus(status: RelayStatus) {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  private write(frame: RelayClientMessage) {
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN)
      this.ws.send(JSON.stringify(frame))
  }

  private connect() {
    if (this.ws || this.timer || this.opening) return
    if (this.status === "update_required") return
    this.closedByUs = false
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting")
    void this.open()
  }

  private async open() {
    // Several callers can ask for a connection in the same tick (a run chat
    // and a presence announcement); the flag keeps them to one socket.
    this.opening = true
    let token: string
    try {
      token = await this.options.getToken()
    } catch {
      this.opening = false
      return this.retry()
    }
    if (this.closedByUs) {
      this.opening = false
      return
    }
    this.opening = false
    const url = new URL(RELAY_PATH, this.options.serverUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set(RELAY_TOKEN_PARAM, token)
    url.searchParams.set(CLIENT_VERSION_PARAM, this.options.clientVersion)
    if (this.options.clientKind)
      url.searchParams.set(CLIENT_KIND_PARAM, this.options.clientKind)
    const ws = new this.WebSocketImpl(url.toString())
    this.ws = ws
    ws.addEventListener("open", () => {
      this.attempt = 0
      this.setStatus("open")
      for (const [runId, watched] of this.runs) {
        this.write({
          v: RELAY_PROTOCOL_VERSION,
          type: "subscribe",
          runId,
          ...(watched.lastSeq > 0 ? { after: watched.lastSeq } : {}),
        })
      }
      // A reconnect is a new presence connection on the server, so every
      // announcement is repeated (ADR 0049).
      for (const [workspaceId, view] of this.presence)
        this.write({
          v: RELAY_PROTOCOL_VERSION,
          type: "presence",
          workspaceId,
          view,
        })
      for (const p of this.pending) this.write(p.frame)
    })
    ws.addEventListener("message", (e) => this.receive(String(e.data)))
    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.closedByUs) return
      if (e.code === RELAY_CLOSE.updateRequired) {
        this.setStatus("update_required")
        for (const p of this.pending.splice(0))
          p.reject(
            new RelayRequestError(
              "update_required",
              "Update Mikka to continue."
            )
          )
        return
      }
      // 4401 (token expired or revoked) reconnects with a fresh token too.
      this.retry()
    })
  }

  private retry() {
    if (this.closedByUs) return
    this.attempt++
    this.setStatus("reconnecting")
    const delay = (this.options.retryDelayMs ?? defaultRetry)(this.attempt)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, delay)
  }

  private settle(match: (p: Pending) => boolean, error?: Error) {
    const index = this.pending.findIndex(match)
    if (index < 0) return
    const [p] = this.pending.splice(index, 1)
    if (error) p!.reject(error)
    else p!.resolve()
  }

  private receive(raw: string) {
    const msg = decodeRelayServerMessage(raw)
    if (!msg) return
    switch (msg.type) {
      case "event": {
        const watched = this.runs.get(msg.runId)
        // A resubscribe can replay what this client already has.
        if (!watched || msg.seq <= watched.lastSeq) return
        watched.lastSeq = msg.seq
        for (const listener of watched.listeners) listener(msg.event, msg.seq)
        return
      }
      case "presence": {
        this.presenceSnapshots.set(msg.workspaceId, msg.members)
        for (const listener of this.presenceListeners.get(msg.workspaceId) ??
          [])
          listener(msg.members)
        return
      }
      case "accepted":
        return this.settle((p) =>
          msg.request === "send"
            ? p.frame.type === "send" && p.frame.messageId === msg.messageId
            : p.frame.type === "stop" && p.frame.runId === msg.runId
        )
      case "error":
        // Errors name the run, not the request: the oldest one for it failed.
        if (msg.runId)
          this.settle(
            (p) => p.frame.runId === msg.runId,
            new RelayRequestError(msg.code, msg.message)
          )
        return
      default:
        return
    }
  }
}
