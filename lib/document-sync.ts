'use client'

import * as Y from 'yjs'
import { exchangeDocument } from '@/app/actions/collaboration'
import { nextSyncSnapshot, type SyncSnapshot } from '@/lib/document-sync-snapshot'

function encode(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
function decode(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

export class DocumentSync {
  readonly doc = new Y.Doc()
  private id: string | undefined
  private seed: string
  private version = 0
  private acknowledged = 0
  /** The stored version from the last answer; an invalidation read sends only this. */
  private known: string | undefined
  private flight: Promise<void> | undefined
  private listeners = new Set<() => void>()
  private snapshot: SyncSnapshot
  constructor(id: string | undefined, seed: Uint8Array) {
    this.id = id
    this.seed = encode(seed)
    this.snapshot = { ready: !id, pending: false, error: false, syncing: false }
    if (!id) Y.applyUpdate(this.doc, seed, 'server')
    this.doc.on('update', (_update, origin) => {
      if (origin === 'server') return
      this.version++
      this.publish({ pending: true })
    })
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = () => this.snapshot
  private publish(patch: Partial<SyncSnapshot>) {
    // A paragraph split writes Yjs twice (the edit, then y-sync's position migration).
    // Notifying React when pending/ready/error/syncing did not change makes useEditor
    // call setOptions, which writes Yjs again, until React hits its update limit.
    const next = nextSyncSnapshot(this.snapshot, patch)
    if (!next) return
    this.snapshot = next
    this.listeners.forEach(listener => listener())
  }
  /** A failed save leaves callbacks attached to the same local Yjs version for the existing retry. */
  afterAcknowledged = (saved: () => void) => {
    const target = this.version
    if (target <= this.acknowledged) { saved(); return }
    const stop = this.subscribe(() => {
      if (this.acknowledged < target) return
      stop()
      saved()
    })
  }
  async exchange(id = this.id) {
    if (!id) return
    if (this.flight) return this.flight
    this.id = id
    const sentVersion = this.version
    const initialized = this.snapshot.ready
    // Local edits, or no version to compare yet, upload the whole state; otherwise the server compares versions only.
    const upload = initialized && (sentVersion !== this.acknowledged || !this.known)
    this.publish({ syncing: true })
    this.flight = (async () => {
      try {
        const result = await exchangeDocument({ id, seed: this.seed, vector: encode(Y.encodeStateVector(this.doc)), update: upload ? encode(Y.encodeStateAsUpdate(this.doc)) : undefined, known: upload ? undefined : this.known })
        if (result.update) Y.applyUpdate(this.doc, decode(result.update), 'server')
        this.known = result.version
        this.acknowledged = sentVersion
        this.publish({ ready: true, pending: this.version !== this.acknowledged, error: false, workspaceId: result.workspaceId })
      } catch (error) {
        this.publish({ error: true })
        throw error
      } finally {
        this.flight = undefined
        this.publish({ syncing: false })
      }
    })()
    return this.flight
  }
  async flush(id = this.id) {
    if (!id) return
    if (this.flight) await this.flight
    await this.exchange(id)
    // Edits made during a request must be acknowledged before taking a version snapshot.
    if (this.version !== this.acknowledged) await this.exchange(id)
    if (this.version !== this.acknowledged) throw new Error('documentPending')
  }
  destroy() {
    this.listeners.clear()
    this.doc.destroy()
  }
}
