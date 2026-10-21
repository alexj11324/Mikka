'use client'

import * as Y from 'yjs'
import { exchangeDocument } from '@/app/actions/collaboration'

function encode(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
function decode(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

type SyncSnapshot = { ready: boolean; pending: boolean; error: boolean; syncing: boolean }
export class DocumentSync {
  readonly doc = new Y.Doc()
  private id: string | undefined
  private seed: string
  private version = 0
  private acknowledged = 0
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
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }
  async exchange(id = this.id) {
    if (!id) return
    if (this.flight) return this.flight
    this.id = id
    const sentVersion = this.version
    const initialized = this.snapshot.ready
    this.publish({ syncing: true })
    this.flight = (async () => {
      try {
        const result = await exchangeDocument({ id, seed: this.seed, vector: encode(Y.encodeStateVector(this.doc)), update: initialized ? encode(Y.encodeStateAsUpdate(this.doc)) : undefined })
        Y.applyUpdate(this.doc, decode(result.update), 'server')
        this.acknowledged = sentVersion
        this.publish({ ready: true, pending: this.version !== this.acknowledged, error: false })
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
