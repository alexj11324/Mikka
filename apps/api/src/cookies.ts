import { parse, serialize, type SerializeOptions } from 'cookie'

export type CookieOptions = SerializeOptions
export type CookieValue = { name: string; value: string } & CookieOptions

/** Request cookies and response mutations are separate: changing the workspace
 * selector must not rewrite the cookie identity used to authenticate a request. */
export class CookieJar {
  private values = new Map<string, CookieValue>()
  private changes = new Map<string, string>()
  private committed = false
  constructor(header: string | null = null, private readonly onChange?: (value: string) => void,
    private readonly onSetCookie?: (name: string, value: string) => void) {
    for (const [name, value] of Object.entries(parse(header ?? ''))) {
      if (value !== undefined) this.values.set(name, { name, value })
    }
  }
  get(name: string | { name: string }): CookieValue | undefined { return this.values.get(typeof name === 'string' ? name : name.name) }
  getAll(name?: string | { name: string }): CookieValue[] {
    if (name === undefined) return [...this.values.values()]
    const item = this.get(name)
    return item ? [item] : []
  }
  has(name: string): boolean { return this.values.has(name) }
  set(name: string, value: string, options?: CookieOptions): this
  set(cookie: CookieValue): this
  set(name: string | CookieValue, value?: string, options: CookieOptions = {}): this {
    if (this.committed) throw new Error('API_COOKIES_ALREADY_COMMITTED')
    const cookie = typeof name === 'string' ? { ...options, name, value: value ?? '' } : name
    const { name: key, value: content, ...attributes } = cookie
    const encoded = serialize(key, content, { path: '/', ...attributes })
    this.values.set(key, { ...cookie })
    this.changes.set(key, encoded)
    this.onSetCookie?.(key, encoded)
    this.onChange?.(this.toString())
    return this
  }
  delete(name: string | { name: string; path?: string; domain?: string }): this {
    const item = typeof name === 'string' ? { name } : name
    this.set({ ...item, value: '', expires: new Date(0) })
    this.values.delete(item.name)
    this.onChange?.(this.toString())
    return this
  }
  toString(): string { return [...this.values.values()].map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ') }
  commit(headers: Headers): void {
    if (this.committed) throw new Error('API_COOKIES_ALREADY_COMMITTED')
    this.committed = true
    // Match Next's response cookie replacement by name, while keeping every
    // unrelated raw field separate (Expires commas are not delimiters).
    if (this.changes.size) {
      const retained = headers.getSetCookie().filter(value => !this.changes.has(value.slice(0, value.indexOf('='))))
      headers.delete('set-cookie')
      for (const value of retained) headers.append('set-cookie', value)
    }
    for (const value of this.changes.values()) headers.append('set-cookie', value)
  }
}
