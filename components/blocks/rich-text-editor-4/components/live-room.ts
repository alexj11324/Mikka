import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness"
import * as Y from "yjs"

import {
  CURRENT_USER,
  TEAMMATES,
  type PeerId,
  type PersonId,
  type PresenceStatus,
} from "./data"
import { createThreadStore, type ThreadStore } from "./rich-text-comments"

/** Updates relayed between clients carry this origin, so nothing echoes. */
export const ROOM_ORIGIN = "live-room"

// Fixed ids keep the demo deterministic: concurrent inserts order by client id.
const CLIENT_IDS: Record<PersonId, number> = {
  arjun: 11,
  maya: 12,
  lena: 13,
  daniel: 14,
}

// Edits closer together than the undo capture window count as one change.
const BURST_MS = 500

export interface RoomClient {
  id: PersonId
  doc: Y.Doc
  awareness: Awareness
}

export interface ConnectionSnapshot {
  online: boolean
  /** Local edit bursts waiting for the connection. */
  pending: number
  /** Any change landed since the room opened. */
  edited: boolean
  /** You changed the text or a thread in this session. */
  editedLocally: boolean
}

export interface PresenceEntry {
  /** The Awareness user id; any provider's users work, not just the demo's. */
  id: string
  status: PresenceStatus
  hasCaret: boolean
  replyingTo: string | null
  /** False once their state left Awareness; the last known entry stays. */
  here: boolean
}

export interface SyncReport {
  flushed: number
  /** Teammates whose edits arrived with the reconnect. */
  merged: string[]
}

interface Store<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

/** What the editor UI reads from a room; a network provider maps onto it. */
export interface RoomAdapter {
  /** Remounts the session when a new room opens. */
  key: number
  /** Handed to Collaboration and CollaborationCaret. */
  local: { doc: Y.Doc; awareness: Awareness }
  /** A provider's status and unsynced-changes events. */
  connection: Store<ConnectionSnapshot>
  presence: Store<PresenceEntry[]>
  threads: ThreadStore
  /** A provider's disconnect() and connect(); call from an event handler. */
  setOnline: (online: boolean) => SyncReport
}

function createStore<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    set(next: T) {
      snapshot = next
      listeners.forEach((listener) => listener())
    },
  }
}

/** Everyone else in Awareness, in join order; caret moves alone never notify. */
export function createPresenceStore(awareness: Awareness) {
  const store = createStore<PresenceEntry[]>([])
  const known = new Map<string, PresenceEntry>()
  let key = ""

  function read() {
    const present = new Set<string>()
    awareness.getStates().forEach((state, clientId) => {
      const id = state?.user?.id
      if (clientId === awareness.clientID || typeof id !== "string") return
      present.add(id)
      known.set(id, {
        id,
        status: state.status ?? "viewing",
        hasCaret: state.cursor != null,
        replyingTo: state.replyingTo ?? null,
        here: true,
      })
    })
    for (const [id, entry] of known) {
      if (!present.has(id)) known.set(id, { ...entry, here: false })
    }
    const entries = [...known.values()]
    const next = JSON.stringify(entries)
    if (next === key) return
    key = next
    store.set(entries)
  }

  read()
  awareness.on("change", read)
  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    destroy: () => awareness.off("change", read),
  }
}

function createClient(id: PersonId, seed: Uint8Array): RoomClient {
  const doc = new Y.Doc()
  // Before any transaction: Awareness copies the id when it is created.
  doc.clientID = CLIENT_IDS[id]
  Y.applyUpdate(doc, seed, ROOM_ORIGIN)
  return { id, doc, awareness: new Awareness(doc) }
}

export type LiveRoom = ReturnType<typeof createLiveRoom>

export function createLiveRoom(seed: Uint8Array, key: number) {
  const local = createClient(CURRENT_USER, seed)
  const others = TEAMMATES.map((id) => createClient(id, seed))
  const clients = [local, ...others]
  // Demo only: the scripted teammates' own clients.
  const peers = Object.fromEntries(
    others.map((client) => [client.id, client])
  ) as Record<PeerId, RoomClient>

  const connection = createStore<ConnectionSnapshot>({
    online: true,
    pending: 0,
    edited: false,
    editedLocally: false,
  })
  let lastLocalAt = 0
  const mergedWhileOffline = new Set<string>()

  const update = (patch: Partial<ConnectionSnapshot>) =>
    connection.set({ ...connection.getSnapshot(), ...patch })
  const isOnline = () => connection.getSnapshot().online
  // Offline cuts the local client out; teammates keep syncing among themselves.
  const linked = (a: RoomClient, b: RoomClient) =>
    isOnline() || (a !== local && b !== local)

  const cleanups: Array<() => void> = []

  for (const from of clients) {
    const onDoc = (change: Uint8Array, origin: unknown) => {
      if (origin === ROOM_ORIGIN) {
        if (from === local && !connection.getSnapshot().edited) {
          update({ edited: true })
        }
        return
      }
      for (const to of clients) {
        if (to !== from && linked(from, to)) {
          Y.applyUpdate(to.doc, change, ROOM_ORIGIN)
        }
      }
      if (from !== local) {
        if (!isOnline()) mergedWhileOffline.add(from.id)
        return
      }
      const snapshot = connection.getSnapshot()
      const now = Date.now()
      const burst = !snapshot.online && now - lastLocalAt > BURST_MS
      lastLocalAt = now
      if (burst || !snapshot.editedLocally || !snapshot.edited) {
        update({
          edited: true,
          editedLocally: true,
          pending: snapshot.pending + (burst ? 1 : 0),
        })
      }
    }
    from.doc.on("update", onDoc)
    cleanups.push(() => from.doc.off("update", onDoc))

    // "update" rather than "change": the 15s renewals must reach the others,
    // or their copies of this client expire after 30s.
    const onAwareness = (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      if (origin !== "local") return
      const changed = encodeAwarenessUpdate(from.awareness, [
        ...added,
        ...updated,
        ...removed,
      ])
      for (const to of clients) {
        if (to !== from && linked(from, to)) {
          applyAwarenessUpdate(to.awareness, changed, ROOM_ORIGIN)
        }
      }
    }
    from.awareness.on("update", onAwareness)
    cleanups.push(() => from.awareness.off("update", onAwareness))
  }

  const presence = createPresenceStore(local.awareness)
  const threads: ThreadStore = createThreadStore(local.doc)

  const adapter: RoomAdapter = {
    key,
    local,
    connection: {
      subscribe: connection.subscribe,
      getSnapshot: connection.getSnapshot,
    },
    presence,
    threads,
    setOnline(next) {
      if (next === isOnline()) return { flushed: 0, merged: [] }
      if (!next) {
        // What a provider does on disconnect: presence is dropped both ways.
        removeAwarenessStates(
          local.awareness,
          others.map((peer) => peer.doc.clientID),
          "offline"
        )
        for (const peer of others) {
          removeAwarenessStates(peer.awareness, [local.doc.clientID], "offline")
        }
        mergedWhileOffline.clear()
        lastLocalAt = 0
        update({ online: false, pending: 0 })
        return { flushed: 0, merged: [] }
      }
      const flushed = connection.getSnapshot().pending
      update({ online: true, pending: 0 })
      // Sync steps one and two, both ways: each side sends what the other's
      // state vector lacks, and Yjs merges without conflicts.
      for (const peer of others) {
        Y.applyUpdate(
          peer.doc,
          Y.encodeStateAsUpdate(local.doc, Y.encodeStateVector(peer.doc)),
          ROOM_ORIGIN
        )
        Y.applyUpdate(
          local.doc,
          Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(local.doc)),
          ROOM_ORIGIN
        )
      }
      // A state removed at clock n ignores a resend at n, so each re-announces.
      for (const client of clients) {
        client.awareness.setLocalState(client.awareness.getLocalState())
      }
      return { flushed, merged: [...mergedWhileOffline] }
    },
  }

  return {
    ...adapter,
    peers,
    destroy() {
      cleanups.forEach((cleanup) => cleanup())
      presence.destroy()
      threads.destroy()
      for (const client of clients) {
        client.awareness.destroy()
        client.doc.destroy()
      }
    },
  }
}

/** The open room for React: rooms open in an effect (Awareness starts a timer
 * when created), and render reads the current one through subscribe/get. */
export function createRoomHolder(
  open: (key: number) => { room: RoomAdapter; close: () => void }
) {
  let current: { room: RoomAdapter; close: () => void } | null = null
  let opened = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => current?.room ?? null,
    open() {
      opened += 1
      const next = open(opened)
      current = next
      notify()
      return next
    },
    close(closing: { room: RoomAdapter; close: () => void }) {
      if (current === closing) {
        current = null
        notify()
      }
      closing.close()
    },
  }
}