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

export const CREDENTIAL_SUBMIT_FUNCTION = 'function(){if(!this.isConnected||this.ownerDocument!==document||!this.form||this.disabled)return false;HTMLFormElement.prototype.requestSubmit.call(this.form,this);return true}'

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
  /** Focus an observed CDP backend node in the top document. This is a
   * mechanical check only; caller must independently consume a trusted,
   * document-bound policy decision before any credential operation. */
  async focusObservedInput(backendNodeId: number, role: 'username' | 'password') {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || !['username', 'password'].includes(role)) throw new CredentialError('credential_denied', 404)
    const result = await this.call('DOM.getDocument', { depth: -1, pierce: false })
    const find = (node: unknown): Record<string, any> | undefined => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
      const item = node as Record<string, any>
      if (item.backendNodeId === backendNodeId) return item
      // Do not traverse shadow roots or iframe content documents.
      if (!Array.isArray(item.children)) return undefined
      for (const child of item.children) {
        const found = find(child)
        if (found) return found
      }
      return undefined
    }
    const input = find(result.root)
    if (!input || input.nodeName !== 'INPUT' || !Array.isArray(input.attributes) || input.attributes.length % 2 !== 0) throw new CredentialError('credential_denied', 404)
    const attributes = new Map<string, string>()
    for (let i = 0; i < input.attributes.length; i += 2) {
      const key = input.attributes[i], value = input.attributes[i + 1]
      if (typeof key !== 'string' || typeof value !== 'string') throw new CredentialError('credential_denied', 404)
      attributes.set(key.toLowerCase(), value)
    }
    const type = (attributes.get('type') ?? 'text').toLowerCase()
    const allowed = role === 'password' ? ['password'] : ['text', 'email', 'tel']
    if (attributes.has('disabled') || attributes.has('readonly') || !allowed.includes(type)) throw new CredentialError('credential_denied', 404)
    await this.call('DOM.focus', { backendNodeId })
    await this.assertObservedFocus(backendNodeId)
    // Replace a prefilled value through native input while the exact focused
    // node is fenced. No page JavaScript receives the secret as an argument.
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  }
  private async assertObservedFocus(backendNodeId: number) {
    // DOM.focus can be a no-op (for example inside a disabled fieldset).
    // Verify actual focus before the caller attempts Input.insertText.
    const active = await this.call('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false })
    if (active.exceptionDetails || typeof active.result?.objectId !== 'string') throw new CredentialError('credential_denied', 404)
    const focused = await this.call('DOM.describeNode', { objectId: active.result.objectId })
    if (focused.node?.backendNodeId !== backendNodeId) throw new CredentialError('credential_denied', 404)
  }
  /** Use only under an active viewer guard, after the host has consumed the
   * existing computer_use permission for this exact document and action. */
  async insertAtObservedInput(origin: string, loaderId: string, backendNodeId: number, role: 'username' | 'password', value: string) {
    const check = async () => {
      const tree = await this.call('Page.getFrameTree')
      const frame = tree.frameTree?.frame
      if (!frame || typeof loaderId !== 'string' || !loaderId || frame.loaderId !== loaderId) throw new CredentialError('credential_denied', 404)
      assertSameOrigin(frame.url, origin)
    }
    await check()
    await this.focusObservedInput(backendNodeId, role)
    await check()
    await this.assertObservedFocus(backendNodeId)
    await this.call('Input.insertText', { text: value })
  }
  async submitObservedButton(origin: string, loaderId: string, backendNodeId: number) {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw new CredentialError('credential_denied', 404)
    const frame = (await this.call('Page.getFrameTree')).frameTree?.frame
    if (!frame || frame.loaderId !== loaderId) throw new CredentialError('credential_denied', 404)
    assertSameOrigin(frame.url, origin)
    const result = await this.call('DOM.resolveNode', { backendNodeId })
    if (typeof result.object?.objectId !== 'string') throw new CredentialError('credential_denied', 404)
    const submitted = await this.call('Runtime.callFunctionOn', { objectId: result.object.objectId, functionDeclaration: CREDENTIAL_SUBMIT_FUNCTION, returnByValue: true })
    if (submitted.exceptionDetails || submitted.result?.value !== true) throw new CredentialError('credential_denied', 404)
  }
  async fill(_origin: string, _username: string, _password: string) {
    // The legacy API has no observed nodes or consumed host permission.
    // Fail closed until the single guarded plan is connected.
    throw new CredentialError('credential_target_required', 409)
  }
  async safeToResume(_initialUrl: string) {
    // A URL change can be pushState/hash rather than navigation. Check every
    // time, including after redirects, before allowing any image or DOM read.
    // Match the gateway: nested frames and author shadow trees are not covered
    // by the top-level evaluator, so fail closed until they can be inspected.
    try {
      const tree = await this.call('Page.getFrameTree')
      const document = await this.call('DOM.getDocument', { depth: -1, pierce: true })
      if (!tree.frameTree || typeof tree.frameTree !== 'object' || Array.isArray(tree.frameTree) || (tree.frameTree.childFrames != null && (!Array.isArray(tree.frameTree.childFrames) || tree.frameTree.childFrames.length > 0)) || !document.root || typeof document.root !== 'object' || Array.isArray(document.root)) return false
      const unsafe = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(unsafe)
        if (!value || typeof value !== 'object') return false
        const node = value as Record<string, any>
        if (['IFRAME', 'FRAME'].includes(String(node.nodeName ?? '').toUpperCase())) return true
        if (node.shadowRoots != null && (!Array.isArray(node.shadowRoots) || node.shadowRoots.some((root: unknown) => !root || typeof root !== 'object' || (root as { shadowRootType?: string }).shadowRootType !== 'user-agent'))) return true
        return Object.values(node).some(unsafe)
      }
      if (unsafe(document.root)) return false
      // An OTP may have any name. Hidden and non-text controls often hold fixed values.
      return await this.evaluate(`![...document.querySelectorAll('input,textarea')].some(e=>e.value && (e.tagName==='TEXTAREA'||!['hidden','checkbox','radio','button','submit','reset','image','file','range','color'].includes(e.type)))`) === true
    } catch { return false }
  }
  async fillOtp(_origin: string, _code: string) {
    throw new CredentialError('credential_target_required', 409)
  }
}
