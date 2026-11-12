import type { ConversationCommand } from './conversation-submission'

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }
type Saved = ConversationCommand & { storedId: string }
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
    return saved?.session === binding.session ? saved : { session: binding.session, scopes: {} } as Index
  }
  return {
    bind(account: string, session: string | null) {
      if (binding?.account === account && binding.session === session) return
      binding = session ? { account, session } : null
      const saved = index(account)
      if (saved && saved.session !== session) clear(account, saved)
    },
    read(scope: string): Saved[] {
      const saved = current()
      if (!saved || !binding) return []
      const account = binding.account
      return Object.entries(saved.scopes).flatMap(([id, value]) => {
        if (scope !== value) return []
        const raw = storage.getItem(commandKey(account, id))
        return raw ? [JSON.parse(raw) as Saved] : []
      })
    },
    remember(scope: string, command: Saved) {
      const saved = current()
      if (!binding || !saved) throw new Error('draftNotSaved')
      const key = commandKey(binding.account, command.id), value = JSON.stringify(command)
      if (saved.scopes[command.id] !== scope) {
        saved.scopes[command.id] = scope
        storage.setItem(indexKey(binding.account), JSON.stringify(saved))
      }
      storage.setItem(key, value)
      // The native adapter can recover an interrupted multi-part write. Only start transport with the exact command saved.
      if (index(binding.account)?.scopes[command.id] !== scope || storage.getItem(key) !== value) throw new Error('draftNotSaved')
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
