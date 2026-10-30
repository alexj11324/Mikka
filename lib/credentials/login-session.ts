import { assertSameOrigin, CredentialError } from './contracts'
import { Cdp, endCredentialGuardWhenSafe, gatewayGuard, type BrowserGuard } from './browser'
import type { LoginSession } from './login-attempts'
import type { BrowserTarget } from './store'

/** Per-site definite signed-in markers. A site without an entry can never reach
 * signed_in (it stays waiting and expires): we do not guess from navigation. */
export type SiteMarkers = { sessionCookies?: string[]; signedInSelector?: string; errorSelector?: string }
export const LOGIN_SITE_MARKERS: Record<string, SiteMarkers> = {}

const CODE_INPUT = 'input[autocomplete~="one-time-code" i],input[name*="otp" i],input[id*="otp" i],input[name*="totp" i],input[name="code" i],input[id="code" i],input[name*="verification" i][inputmode="numeric"]'
const ERROR = '[role="alert"],[aria-live="assertive"],[aria-invalid="true"]'

/** Page facts only. Expressions return booleans and the URL, never field values. */
export function snapshotExpression(markers: SiteMarkers) {
  const visible = `e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)`
  const error = markers.errorSelector ? `${ERROR},${markers.errorSelector}` : ERROR
  return `(()=>{const v=${visible};return {url:location.href,codeInput:[...document.querySelectorAll(${JSON.stringify(CODE_INPUT)})].some(v),errorMessage:[...document.querySelectorAll(${JSON.stringify(error)})].some(e=>v(e)&&(e.getAttribute('aria-invalid')==='true'||(e.textContent||'').trim().length>0)),signedInElement:${markers.signedInSelector ? `[...document.querySelectorAll(${JSON.stringify(markers.signedInSelector)})].some(v)` : 'false'}}})()`
}

type CdpLike = Pick<Cdp, 'call' | 'attach' | 'evaluate' | 'origin' | 'insertAtObservedInput' | 'safeToResume' | 'close'>

export async function readLoginPage(cdp: CdpLike, origin: string, markers: SiteMarkers) {
  const page = await cdp.evaluate(snapshotExpression(markers))
  if (!page || typeof page.url !== 'string') throw new CredentialError()
  let cookie = false
  if (markers.sessionCookies?.length) {
    const { cookies } = await cdp.call('Network.getCookies', { urls: [origin] })
    cookie = Array.isArray(cookies) && cookies.some((c: { name?: string; value?: string }) => markers.sessionCookies!.includes(String(c.name)) && !!c.value)
  }
  return { url: page.url, codeInput: page.codeInput === true, errorMessage: page.errorMessage === true, signedInMarker: cookie || page.signedInElement === true }
}

async function pressEnter(cdp: CdpLike) {
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
}

/** The live CDP session that types the pending credential. Lives as long as the attempt. */
export async function openCdpLoginSession(target: BrowserTarget, deps: { guard?: BrowserGuard; connect?: (url: string) => Promise<CdpLike>; markers?: SiteMarkers } = {}): Promise<LoginSession> {
  const guard = deps.guard ?? gatewayGuard, markers = deps.markers ?? LOGIN_SITE_MARKERS[target.origin] ?? {}
  const inputs = target.observedInputs ?? []
  if (!inputs.length) throw new CredentialError('credential_target_required', 409)
  const begin = async () => {
    const { cdpUrl, targetId, guardToken } = await guard.begin(target)
    if (targetId !== target.targetId) throw new CredentialError()
    const cdp = await (deps.connect ?? Cdp.connect)(cdpUrl)
    await cdp.attach(targetId)
    return { cdp, guardToken }
  }
  const viewer = await begin()
  let cdp = viewer.cdp, guardToken: string | null = viewer.guardToken
  const release = async (initialUrl: string) => {
    if (!guardToken) return
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !await cdp.safeToResume(initialUrl)) await new Promise(r => setTimeout(r, 250))
    await endCredentialGuardWhenSafe(cdp, guard, target, guardToken, target.origin, initialUrl)
    guardToken = null
  }
  return {
    async submitPassword(username, password) {
      const frame = (await cdp.call('Page.getFrameTree')).frameTree?.frame
      assertSameOrigin(frame?.url ?? '', target.origin)
      for (const input of inputs) await cdp.insertAtObservedInput(target.origin, input.loaderId, input.backendNodeId, input.credentialRole, input.credentialRole === 'password' ? password : username)
      await pressEnter(cdp)
      await release(frame.url)
    },
    async submitCode(code) {
      if (!guardToken) ({ cdp, guardToken } = await begin())
      await cdp.origin(target.origin)
      const focused = await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(CODE_INPUT)});if(!e)return false;e.focus();return document.activeElement===e})()`)
      if (focused !== true) throw new CredentialError('credential_denied', 404)
      const frame = (await cdp.call('Page.getFrameTree')).frameTree?.frame
      await cdp.call('Input.insertText', { text: code })
      await pressEnter(cdp)
      await release(frame?.url ?? target.origin)
    },
    snapshot: () => readLoginPage(cdp, target.origin, markers),
    async close() { cdp.close() },
  }
}
