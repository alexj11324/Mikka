import type { ConversationCommand } from './conversation-submission'
import type { Outgoing } from './outbox'

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }
type Saved = ConversationCommand & { storedId: string }
type Entry = Saved | Outgoing
const personal = (entry: Entry): entry is Outgoing => 'submissionId' in entry
type Index = { session: string; scopes: Record<string, string> }

/** Each operation uses its own storage value so the existing native chunked store handles long messages. */
export function createConversationJournal(storage: Storage) {
  let binding: { account: string; session: string } | null = null
  const indexKey = (account: string) => `mikka_conversation_index_${account}`
  const commandKey = (account: string, id: string) => `mikka_conversation_send_${account}_${id}`
  function index(account: string): Index | null {
    const raw = storage.getItem(indexKey(account))
    return raw ? JSON.parse(raw) : null
  }
  function clear(account: string, old: Index) {
    storage.setItem(indexKey(account), '')
    for (const id of Object.keys(old.scopes)) storage.setItem(commandKey(account, id), '')
  }
  function current() {
    if (!binding) return null
    const saved = index(binding.account)
    if (saved && saved.session !== binding.session) return null
    return saved ?? { session: binding.session, scopes: {} } as Index
  }
  function read(scope: string): Entry[] {
    const saved = current()
    if (!saved || !binding) return []
    const account = binding.account
    return Object.entries(saved.scopes).flatMap(([id, value]) => {
      if (scope !== value) return []
      const raw = storage.getItem(commandKey(account, id))
      return raw ? [JSON.parse(raw) as Entry] : []
    })
  }
  function remember(scope: string, id: string, entry: Entry) {
    const saved = current()
    if (!binding || !saved) throw new Error('draftNotSaved')
    const existingScope = saved.scopes[id]
    if (existingScope !== undefined && existingScope !== scope) throw new Error('draftNotSaved')
    const account = binding.account, key = commandKey(account, id), value = JSON.stringify(entry)
    if (existingScope === undefined) {
      saved.scopes[id] = scope
      storage.setItem(indexKey(account), JSON.stringify(saved))
    }
    const stored = index(account)
    if (stored?.session !== saved.session || stored.scopes[id] !== scope) throw new Error('draftNotSaved')
    // Reserve the index first so logout can erase an interrupted chunked write.
    storage.setItem(key, value)
    if (storage.getItem(key) !== value) throw new Error('draftNotSaved')
  }
  return {
    bind(account: string, session: string | null) {
      if (binding?.account === account && binding.session === session) return
      binding = session ? { account, session } : null
      const saved = index(account)
      if (saved && saved.session !== session) clear(account, saved)
    },
    read(scope: string): Saved[] {
      return read(scope).filter((entry): entry is Saved => !personal(entry))
    },
    readPersonal(scope: string): Outgoing[] {
      return read(scope).filter(personal)
    },
    remember(scope: string, command: Saved) {
      remember(scope, command.id, command)
    },
    rememberPersonal(scope: string, item: Outgoing) {
      remember(scope, item.submissionId, item)
    },
    forget(scope: string, ids?: readonly string[]) {
      const saved = current()
      if (!binding || !saved) return
      const remove = Object.entries(saved.scopes).filter(([id, value]) => scope === value && (!ids || ids.includes(id)))
      if (!remove.length) return
      for (const [id] of remove) delete saved.scopes[id]
      storage.setItem(indexKey(binding.account), JSON.stringify(saved))
      for (const [id] of remove) storage.setItem(commandKey(binding.account, id), '')
    },
  }
}
