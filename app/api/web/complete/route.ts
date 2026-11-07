import { createHash } from 'node:crypto'
import { webAuthHeaders } from '@/lib/web-connection/auth-server'

export const dynamic = 'force-dynamic'
// No interpolated input, cookies, bearer, or session lookup. Fragments never reach the server.
const handoffScript = `(() => {
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  const params = new URLSearchParams(fragment.slice(1));
  const state = params.get('state');
  const code = params.get('code');
  if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(state || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(code || '')) return;
  const message = { type: 'mikka.web.handoff', state, code };
  if (window.opener) window.opener.postMessage(message, location.origin);
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('mikka.web.handoff:' + state);
    channel.postMessage(message);
    channel.close();
  }
  window.close();
})();`
export async function GET() {
  const digest = createHash('sha256').update(handoffScript).digest('base64')
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Mikka</title></head><body><script>${handoffScript}</script></body></html>`, { headers: {
    ...webAuthHeaders, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cross-Origin-Opener-Policy': 'unsafe-none',
  } })
}
