import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { EnrollmentClient } from './subscription-enrollment'

const bodySchema = z.object({ id: z.uuid(), provider: z.literal('claude'), handoffKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), callbackUrl: z.string().min(1).max(8192) }).strict()
const privateHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
export function enrollmentHandoffHTTP(deps: { enabled(): boolean; client(): Pick<EnrollmentClient, 'handoff'> }) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!deps.enabled()) return Response.json({ error: 'handoff_unavailable' }, { status: 404, headers: privateHeaders })
      if (request.method !== 'POST' || new URL(request.url).search || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) return Response.json({ error: 'request_refused' }, { status: 403, headers: privateHeaders })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'invalid_request' }, { status: 415, headers: privateHeaders })
      const reader = request.body?.getReader()
      if (!reader) throw new Error()
      let size = 0; const chunks: Uint8Array[] = []
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 12000) { await reader.cancel(); throw new Error() }; chunks.push(value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const body = bodySchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
      // Go loads the original principal from the vault attempt and enforces the
      // capability's complete state/PKCE/provider/expiry binding and shared latch.
      return Response.json(await deps.client().handoff(body), { headers: privateHeaders })
    } catch { return Response.json({ error: 'handoff_refused' }, { status: 409, headers: privateHeaders }) }
  }
}

// Transport page only: no operator/vault identity or provider token is rendered.
// Initial launch data and callback travel in fragments (not server URLs/logs).
// The loopback relay redirects here; the browser POSTs on this same origin.
export function enrollmentHandoffPage(request: Request, enabled: boolean): Response {
  if (!enabled || request.method !== 'GET' || new URL(request.url).search) return new Response(null, { status: 404, headers: privateHeaders })
  const nonce = randomBytes(24).toString('base64')
  const script = `(()=>{const slot='mikka.byos.handoff.v1';let busy=false;const run=async()=>{if(busy)return;busy=true;try{const params=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);const keys=[...params.keys()];if(new Set(keys).size!==keys.length)throw Error();if(params.has('authorizationUrl')){if(keys.length!==4||!['id','provider','handoffKey','authorizationUrl'].every(k=>params.has(k)))throw Error();const id=params.get('id'),provider=params.get('provider'),handoffKey=params.get('handoffKey'),target=new URL(params.get('authorizationUrl'));if(!/^[a-f0-9-]{36}$/.test(id)||provider!=='claude'||!/^[A-Za-z0-9_-]{43}$/.test(handoffKey)||target.origin!=='https://claude.ai'||target.pathname!=='/oauth/authorize'||target.hash||target.username||target.password||target.searchParams.get('client_id')!=='9d1c250a-e61b-44d9-88ed-5944d1962f5e'||target.searchParams.get('redirect_uri')!=='http://localhost:54545/callback'||target.searchParams.get('code_challenge_method')!=='S256'||target.searchParams.get('response_type')!=='code'||target.searchParams.get('code')!=='true'||!/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('state'))||!/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('code_challenge'))||[...target.searchParams.keys()].length!==8||new Set(target.searchParams.keys()).size!==8||[...new Set(target.searchParams.get('scope').split(' '))].sort().join(' ')!==['user:profile','user:inference','user:sessions:claude_code','user:mcp_servers','user:file_upload'].sort().join(' '))throw Error();sessionStorage.setItem(slot,JSON.stringify({id,provider,handoffKey}));location.replace(target.href);return}if(keys.length!==1||keys[0]!=='callbackUrl')throw Error();const raw=sessionStorage.getItem(slot);sessionStorage.removeItem(slot);if(!raw)throw Error();const saved=JSON.parse(raw);const result=await fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({...saved,callbackUrl:params.get('callbackUrl')})});document.body.textContent=result.ok?'Authorization saved on Mikka. Account binding and task acceptance are separate.':'Authorization was not confirmed. Ask the operator to check custody status; do not paste the callback into chat.'}catch{document.body.textContent='Authorization handoff refused or expired. No credentials were displayed.'}finally{busy=false;if(location.hash)queueMicrotask(run)}};addEventListener('hashchange',()=>void run());void run()})();`
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Mikka authorization handoff</title><body>Processing authorization…<script nonce="${nonce}">${script}</script></body>`, { headers: { ...privateHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } })
}
