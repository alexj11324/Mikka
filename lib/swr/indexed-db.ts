export type StoredRead = { key: string; rawKey: unknown; data: unknown; savedAt: number }
export interface ReadStorage {
  activate(scope: string, isCurrent?: () => boolean): Promise<StoredRead[]>
  write(scope: string, value: StoredRead): Promise<void>
  remove(scope: string, key: string): Promise<void>
  clear(scope?: string): Promise<void>
}

const DATABASE = 'mikka-read-cache'
const MAX_ENTRIES = 200
const MAX_ENTRY_BYTES = 2_000_000
type DiskRead = StoredRead & { id: string; scope: string }

/** One database, isolated namespaces. The active scope is checked in the same
 * transaction as every write, so a late response from an old tab cannot put a
 * logged-out account's data back after a clear or workspace/account switch. */
export class IndexedReadStorage implements ReadStorage {
  private database?: Promise<IDBDatabase>

  private open() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('reads', { keyPath: 'id' }).createIndex('savedAt', 'savedAt')
        database.createObjectStore('scope')
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new DOMException('Read cache upgrade blocked', 'InvalidStateError'))
    })
    return this.database
  }

  private async transaction<T>(run: (reads: IDBObjectStore, scope: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const database = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(['reads', 'scope'], 'readwrite')
      let result: T
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      run(transaction.objectStore('reads'), transaction.objectStore('scope'), value => { result = value })
    })
  }

  activate(scope: string, isCurrent: () => boolean = () => true): Promise<StoredRead[]> {
    return this.transaction((reads, scopes, done) => {
      // Opening IndexedDB may finish after another tab switched accounts. Check
      // at transaction creation, before this old activation can replace it.
      if (!isCurrent()) { done([]); return }
      const values: StoredRead[] = []
      scopes.put(scope, 'active')
      const cursor = reads.openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) { done(values); return }
        const value = row.value as DiskRead
        if (value.scope === scope) values.push(value)
        else row.delete()
        row.continue()
      }
    })
  }

  async write(scope: string, value: StoredRead): Promise<void> {
    if (JSON.stringify(value).length > MAX_ENTRY_BYTES) { await this.remove(scope, value.key); return }
    return this.transaction((reads, scopes, done) => {
      const active = scopes.get('active')
      active.onsuccess = () => {
        if (active.result !== scope) { done(); return }
        reads.put({ ...value, scope, id: JSON.stringify([scope, value.key]) } satisfies DiskRead)
        const count = reads.count()
        count.onsuccess = () => {
          let excess = count.result - MAX_ENTRIES
          if (excess <= 0) return
          const cursor = reads.index('savedAt').openCursor()
          cursor.onsuccess = () => {
            const row = cursor.result
            if (!row || excess-- <= 0) return
            row.delete(); row.continue()
          }
        }
        done()
      }
    })
  }

  remove(scope: string, key: string): Promise<void> {
    return this.transaction((reads, _scopes, done) => { reads.delete(JSON.stringify([scope, key])); done() })
  }

  clear(scope?: string): Promise<void> {
    return this.transaction((reads, scopes, done) => {
      if (!scope) { reads.clear(); scopes.delete('active'); done(); return }
      const active = scopes.get('active')
      active.onsuccess = () => { if (active.result === scope) scopes.delete('active') }
      const cursor = reads.openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) { done(); return }
        if ((row.value as DiskRead).scope === scope) row.delete()
        row.continue()
      }
    })
  }
}
