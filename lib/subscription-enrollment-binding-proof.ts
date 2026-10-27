import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const targetSchema = z.object({
  id: z.uuid(), ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), workspaceId: z.uuid(),
  origin: z.url(), databaseIdentity: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const proofSchema = targetSchema.extend({ purpose: z.literal('mikka.byos.enrollment.bind.v1'), expiresAt: z.number().int().positive() }).strict()
export type EnrollmentBindingTarget = z.infer<typeof targetSchema>

export function enrollmentBindingDatabaseIdentity(raw: string) {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error('binding_database_unavailable')
  return createHash('sha256').update(`${url.hostname.toLowerCase().replaceAll('-pooler.', '.')}:${url.port || '5432'}${url.pathname}`).digest('hex')
}
function signingKey(operator: string) {
  if (operator.length < 32) throw new Error('binding_operator_unavailable')
  return createHmac('sha256', operator).update('mikka.byos.enrollment.bind.key.v1').digest()
}
function target(value: EnrollmentBindingTarget) {
  const parsed = targetSchema.parse(value), origin = new URL(parsed.origin)
  if (origin.protocol !== 'https:' || origin.origin !== parsed.origin || origin.username || origin.password) throw new Error('binding_origin_refused')
  return parsed
}
// Private operator issuance only. The proof never grants a Mikka session or
// bypasses workspace authorization. Same-target retries preserve publication
// recovery; the worker's immutable ownership/epoch fence remains authoritative.
export function mintEnrollmentBindingProof(operator: string, value: EnrollmentBindingTarget, now = Date.now(), lifetimeMs = 300000) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 300000) throw new Error('binding_expiry_refused')
  const payload = Buffer.from(JSON.stringify({ ...target(value), purpose: 'mikka.byos.enrollment.bind.v1', expiresAt: now + lifetimeMs })).toString('base64url')
  const signature = createHmac('sha256', signingKey(operator)).update(payload).digest('base64url')
  return `${payload}.${signature}`
}
export function verifyEnrollmentBindingProof(operator: string, proof: string, expected: EnrollmentBindingTarget, now = Date.now()) {
  try {
    if (proof.length > 2048 || !Number.isSafeInteger(now)) return false
    const parts = proof.split('.')
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false
    const [payload, signature] = parts, supplied = Buffer.from(signature, 'base64url')
    const wanted = createHmac('sha256', signingKey(operator)).update(payload).digest()
    if (supplied.length !== wanted.length || supplied.toString('base64url') !== signature || !timingSafeEqual(supplied, wanted)) return false
    const raw = Buffer.from(payload, 'base64url')
    if (raw.toString('base64url') !== payload) return false
    const parsed = proofSchema.parse(JSON.parse(raw.toString('utf8'))), wantedTarget = target(expected)
    if (parsed.expiresAt <= now || parsed.expiresAt > now + 300000) return false
    return Object.entries(wantedTarget).every(([key, value]) => parsed[key as keyof EnrollmentBindingTarget] === value)
  } catch { return false }
}

export function enrollmentBindingPage() {
  // Only a scoped proof enters the browser. Immediately scrub the fragment and
  // do not persist it, emit it in errors, or navigate to a supplied destination.
  const script = `(()=>{let busy=false;const send=async()=>{if(busy)return;busy=true;try{const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);if([...p.keys()].length!==3||new Set(p.keys()).size!==3||!['id','workspaceId','proof'].every(k=>p.has(k)))throw Error();const r=await fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(p))});document.body.textContent=r.ok?'Subscription bound to your authenticated Mikka workspace. Model execution is a separate acceptance step.':'Binding was not confirmed. Sign in to this Mikka environment and ask the operator to check status; do not paste the URL into chat.'}catch{document.body.textContent='Binding handoff refused or expired. No credentials were displayed.'}finally{busy=false;if(location.hash)queueMicrotask(send)}};addEventListener('hashchange',()=>void send());void send()})();`
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Mikka subscription binding</title><body>Checking your Mikka session…<script>${script}</script></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` },
  })
}
