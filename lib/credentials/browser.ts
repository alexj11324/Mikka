import { assertSameOrigin, CredentialError } from './contracts'
import type { BrowserTarget } from './store'

export interface BrowserGuard {
  begin(target: BrowserTarget): Promise<{ cdpUrl: string; targetId: string; guardToken: string }>
  end(target: BrowserTarget, guardToken: string): Promise<void>
}
function gatewayUrl(target: BrowserTarget, action: string) {
  const url = new URL(target.endpoint)
  // This checks infrastructure, never the websites the browser can visit.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.e2b.app') || url.username || url.password) throw new CredentialError()
  url.pathname = `${url.pathname.replace(/\/$/, '')}/credentials/${action}`
  return url
}
export const gatewayGuard: BrowserGuard = {
  async begin(target) {
    const response = await fetch(gatewayUrl(target, 'begin'), { method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store' })
    if (!response.ok) throw new CredentialError()
    const value = await response.json()
    const cdp = new URL(value.cdpUrl)
    if (cdp.protocol !== 'wss:' || cdp.hostname !== new URL(target.endpoint).hostname || value.targetId !== target.targetId || typeof value.guardToken !== 'string') throw new CredentialError()
    return value as { cdpUrl: string; targetId: string; guardToken: string }
  },
  async end(target, guardToken) {
    const response = await fetch(gatewayUrl(target, 'end'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guardToken }), signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store' })
    if (!response.ok) throw new CredentialError()
  },
}

/** Deliberately no CDP logger, remote exception, message body or console handler. */
export class Cdp {
  private id = 0
  private sessionId?: string
  private pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data)), task = this.pending.get(message.id)
        if (!task) return
        clearTimeout(task.timer); this.pending.delete(message.id)
        if (message.error) task.reject(); else task.resolve(message.result ?? {})
      } catch { /* Unknown events and malformed provider messages never enter logs. */ }
    })
    socket.addEventListener('close', () => this.close())
  }
  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new CredentialError()) }, 10_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new CredentialError()) }, { once: true })
    })
    return new Cdp(socket)
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CredentialError()) }, 10_000)
      this.pending.set(id, { resolve, reject: () => reject(new CredentialError()), timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(this.sessionId && !method.startsWith('Target.') ? { sessionId: this.sessionId } : {}) }))
    })
  }
  async attach(targetId: string) {
    const result = await this.call('Target.attachToTarget', { targetId, flatten: true })
    if (typeof result.sessionId !== 'string') throw new CredentialError()
    this.sessionId = result.sessionId
  }
  close() {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject() }
    this.pending.clear()
    if (this.socket.readyState < 2) this.socket.close()
  }
  async origin(expected: string) {
    const tree = await this.call('Page.getFrameTree')
    assertSameOrigin(tree.frameTree.frame.url, expected)
  }
  async evaluate(expression: string) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new CredentialError()
    return result.result?.value
  }
  async fill(origin: string, username: string, password: string) {
    await this.origin(origin)
    // Focus only top-frame inputs. No cross-origin iframe or model-selected JS.
    const focus = (selector: string) => this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.readOnly)return false;e.focus();e.value='';return document.activeElement===e})()`)
    if (!await focus('input[autocomplete="username"],input[type="email"],input[name="username"]')) throw new CredentialError()
    await this.origin(origin); await this.call('Input.insertText', { text: username })
    if (!await focus('input[type="password"]')) throw new CredentialError()
    await this.origin(origin); await this.call('Input.insertText', { text: password })
    await this.origin(origin)
    await this.evaluate(`(()=>{const e=document.querySelector('input[type="password"]');if(!e?.form)return false;e.form.requestSubmit();return true})()`)
  }
  async safeToResume(_initialUrl: string) {
    // A URL change can be pushState/hash rather than navigation. Check every
    // time, including after redirects, before allowing any image or DOM read.
    return await this.evaluate(`![...document.querySelectorAll('input')].some(e=>e.value && (e.type==='password'||e.autocomplete==='one-time-code'))`) === true
  }
  async fillOtp(origin: string, code: string) {
    await this.origin(origin)
    const focused = await this.evaluate(`(()=>{const e=document.querySelector('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]');if(!e||e.disabled||e.readOnly)return false;e.focus();e.value='';return document.activeElement===e})()`)
    if (!focused) throw new CredentialError()
    await this.origin(origin); await this.call('Input.insertText', { text: code })
    await this.origin(origin)
    await this.evaluate(`(()=>{const e=document.querySelector('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]');if(!e?.form)return false;e.form.requestSubmit();return true})()`)
  }
}
