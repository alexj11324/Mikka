import * as Y from "yjs"

import {
  currentTime,
  OFFLINE_TRACK,
  PEER_TRACKS,
  TEAMMATES,
  type PeerId,
  type PresenceStatus,
} from "./data"
import { createLiveRoom, type LiveRoom, type RoomClient } from "./live-room"
import { addThread, COMMENT_MARK, replyToThread } from "./rich-text-comments"
import { getSeedUpdate, SPEC_FIELD } from "./spec-document"
import { awarenessUser } from "./value-faces"

export const PEER_ORIGIN = "peer-script"

export type PeerStep =
  | { kind: "status"; status: PresenceStatus }
  | { kind: "caret"; phrase: string }
  | { kind: "type"; text: string }
  | { kind: "select"; phrase: string }
  | { kind: "comment"; phrase: string; thread: string; body: string }
  | { kind: "reply"; thread: string; body: string; ms: number }
  | { kind: "check"; phrase: string }
  | { kind: "pause"; ms: number }

export interface PeerTrack {
  peer: PeerId
  /** Delay before the first step, in ms. */
  startAt: number
  steps: PeerStep[]
}

interface TextPoint {
  text: Y.XmlText
  index: number
}

function* texts(type: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  for (const child of type.toArray()) {
    if (child instanceof Y.XmlText) yield child
    else if (child instanceof Y.XmlElement) yield* texts(child)
  }
}

// toString() would include mark tags; the delta holds the plain characters.
function plain(text: Y.XmlText) {
  return text
    .toDelta()
    .map((op: { insert?: unknown }) =>
      typeof op.insert === "string" ? op.insert : ""
    )
    .join("")
}

function findPhrase(doc: Y.Doc, phrase: string): TextPoint | null {
  for (const text of texts(doc.getXmlFragment(SPEC_FIELD))) {
    const index = plain(text).indexOf(phrase)
    if (index >= 0) return { text, index }
  }
  return null
}

// Sticks to the character on the left (the peer's own last one), so text you
// type at their caret never lands inside their word.
function after(text: Y.XmlText, index: number) {
  return Y.createRelativePositionFromTypeIndex(text, index, -1)
}

function before(text: Y.XmlText, index: number) {
  return Y.createRelativePositionFromTypeIndex(text, index)
}

/** True when any character in the run already anchors a thread. */
function hasComment(text: Y.XmlText, index: number, length: number) {
  let offset = 0
  for (const op of text.toDelta() as Array<{
    insert?: unknown
    attributes?: Record<string, unknown>
  }>) {
    const size = typeof op.insert === "string" ? op.insert.length : 1
    const overlaps = offset < index + length && offset + size > index
    if (overlaps && op.attributes?.[COMMENT_MARK]) return true
    offset += size
  }
  return false
}

function publishCaret(
  client: RoomClient,
  anchor: Y.RelativePosition,
  head = anchor
) {
  client.awareness.setLocalStateField("cursor", {
    anchor: Y.relativePositionToJSON(anchor),
    head: Y.relativePositionToJSON(head),
  })
}

/** A seeded generator, so every replay types with the same rhythm. */
function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEEDS: Record<PeerId, number> = { maya: 7, lena: 19, daniel: 31 }

function keystrokeDelay(random: () => number, typed: string) {
  const base = 45 + random() * 80
  if (/[.,;]/.test(typed)) return base + 220
  if (typed === " " && random() < 0.2) return base + 160
  return base
}

/** Plays one teammate's steps on its own doc; `instant` skips the waiting. */
function createPeer(client: RoomClient, peer: PeerId) {
  let caret: Y.RelativePosition | null = null

  function resolveCaret() {
    if (!caret) return null
    const at = Y.createAbsolutePositionFromRelativePosition(caret, client.doc)
    return at && at.type instanceof Y.XmlText
      ? { text: at.type, index: at.index }
      : null
  }

  function type(chars: string) {
    const point = resolveCaret()
    if (!point) return
    // Explicit empty attributes: never inherit a comment from the left.
    client.doc.transact(
      () => point.text.insert(point.index, chars, {}),
      PEER_ORIGIN
    )
    caret = after(point.text, point.index + chars.length)
    publishCaret(client, caret)
  }

  function run(step: PeerStep) {
    switch (step.kind) {
      case "status":
        client.awareness.setLocalStateField("status", step.status)
        return
      case "caret": {
        const point = findPhrase(client.doc, step.phrase)
        caret = point
          ? after(point.text, point.index + step.phrase.length)
          : null
        if (caret) publishCaret(client, caret)
        return
      }
      case "select": {
        const point = findPhrase(client.doc, step.phrase)
        if (!point) return
        caret = after(point.text, point.index + step.phrase.length)
        publishCaret(client, before(point.text, point.index), caret)
        return
      }
      case "comment": {
        const point = findPhrase(client.doc, step.phrase)
        // You commented on this text first: a real client would not steal it.
        if (!point || hasComment(point.text, point.index, step.phrase.length)) {
          return
        }
        const at = currentTime()
        client.doc.transact(() => {
          point.text.format(point.index, step.phrase.length, {
            [COMMENT_MARK]: { id: step.thread },
          })
          addThread(
            client.doc,
            {
              id: step.thread,
              author: peer,
              createdAt: at,
              messages: [{ author: peer, body: step.body, at }],
            },
            PEER_ORIGIN
          )
        }, PEER_ORIGIN)
        return
      }
      case "reply":
        client.awareness.setLocalStateField("replyingTo", null)
        replyToThread(
          client.doc,
          step.thread,
          { author: peer, body: step.body, at: currentTime() },
          PEER_ORIGIN
        )
        return
      case "check": {
        const point = findPhrase(client.doc, step.phrase)
        const item = point?.text.parent?.parent
        if (item instanceof Y.XmlElement && item.nodeName === "taskItem") {
          client.doc.transact(
            () => item.setAttribute("checked", true as unknown as string),
            PEER_ORIGIN
          )
        }
        return
      }
      case "type":
        type(step.text)
        return
      case "pause":
        return
    }
  }

  return { run, type }
}

/** Each teammate announces who they are, as their own client would on join. */
function joinPeers(room: LiveRoom) {
  for (const id of TEAMMATES) {
    room.peers[id].awareness.setLocalState({
      user: awarenessUser(id),
      status: "viewing",
    })
  }
}

/** Writes every track's end state at once, for the frozen demo. */
function applyTracksInstantly(room: LiveRoom, tracks: PeerTrack[]) {
  for (const track of tracks) {
    const peer = createPeer(room.peers[track.peer], track.peer)
    for (const step of track.steps) peer.run(step)
  }
}

/** Plays tracks in real time; returns a cancel for the pending timers. */
function playTracks(room: LiveRoom, tracks: PeerTrack[], onDone?: () => void) {
  const timers = new Set<number>()
  let remaining = tracks.length

  const wait = (ms: number, next: () => void) => {
    const timer = window.setTimeout(() => {
      timers.delete(timer)
      next()
    }, ms)
    timers.add(timer)
  }

  for (const track of tracks) {
    const client = room.peers[track.peer]
    const peer = createPeer(client, track.peer)
    const random = mulberry32(SEEDS[track.peer])

    const step = (index: number) => {
      const current = track.steps[index]
      if (!current) {
        remaining -= 1
        if (remaining === 0) onDone?.()
        return
      }
      if (current.kind === "pause") {
        wait(current.ms, () => step(index + 1))
        return
      }
      if (current.kind === "reply") {
        // Shown as "Lena is replying" on the thread until the message lands.
        client.awareness.setLocalStateField("replyingTo", current.thread)
        wait(current.ms, () => {
          peer.run(current)
          step(index + 1)
        })
        return
      }
      if (current.kind === "type") {
        const typeFrom = (offset: number) => {
          const char = current.text[offset]
          if (char === undefined) {
            step(index + 1)
            return
          }
          peer.type(char)
          wait(keystrokeDelay(random, char), () => typeFrom(offset + 1))
        }
        typeFrom(0)
        return
      }
      peer.run(current)
      wait(120 + random() * 160, () => step(index + 1))
    }

    wait(track.startAt, () => step(0))
  }

  return () => {
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
  }
}

/** The whole demo session: the live tracks, then one offline edit to merge
 * the first time you disconnect after they settle. Returns a cancel. */
function startPeerSession(
  room: LiveRoom,
  tracks: PeerTrack[],
  offlineTrack: PeerTrack
) {
  let settled = false
  let offlinePlayed = false
  let wasOnline = room.connection.getSnapshot().online
  const cancels = [playTracks(room, tracks, () => (settled = true))]

  const unsubscribe = room.connection.subscribe(() => {
    const { online } = room.connection.getSnapshot()
    if (online === wasOnline) return
    wasOnline = online
    if (online || !settled || offlinePlayed) return
    offlinePlayed = true
    cancels.push(playTracks(room, [offlineTrack]))
  })

  return () => {
    unsubscribe()
    cancels.forEach((cancel) => cancel())
  }
}

/** The demo room: seeded clients, the teammates joined, the script playing. */
export function openDemoRoom(key: number) {
  const room = createLiveRoom(getSeedUpdate(), key)
  joinPeers(room)
  // Frozen demo guard: ?demo=frozen writes the end state, so no timer starts.
  if (document.documentElement.dataset.demo === "frozen") {
    applyTracksInstantly(room, PEER_TRACKS)
    return { room, close: room.destroy }
  }
  const stop = startPeerSession(room, PEER_TRACKS, OFFLINE_TRACK)
  return {
    room,
    close() {
      stop()
      room.destroy()
    },
  }
}