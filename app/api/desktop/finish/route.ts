import { BASE_PATH } from '@/lib/base-path'
import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'

export const dynamic = 'force-dynamic'

const safeHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

/**
 * Loaded inside the desktop shell after its loopback callback.
 * The one-time code is in the fragment, so it never reaches a proxy log. The
 * page checks the nonce the renderer stored before opening the browser,
 * trades the code and the verifier it kept for a one-minute token, exchanges it for the Electron session cookie,
 * then returns to the requested in-app page.
 */
export async function GET(request: Request) {
  const chinese = request.headers.get('accept-language')?.startsWith('zh')
  const copy = (chinese ? zh : en).DesktopHandoff
  const html = `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.finishTitle}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f4;color:#1c1917}main{max-width:28rem;padding:2rem;text-align:center}a{display:inline-block;margin-top:1rem;padding:.7rem 1.2rem;border-radius:.75rem;background:#1c1917;color:#fff;text-decoration:none}</style><main><h1>${copy.finishTitle}</h1><p id="status">${copy.finishBody}</p><a id="signin" href="${BASE_PATH}/sign-in?oauth=failed" hidden>${copy.openSignIn}</a></main><script>
(() => {
  const base = ${JSON.stringify(BASE_PATH)};
  const key = 'mikka:desktop-oauth';
  const status = document.getElementById('status');
  const signin = document.getElementById('signin');
  const fail = () => { status.textContent = ${JSON.stringify(copy.finishFailed)}; signin.hidden = false; };
  const safeNext = value => {
    if (!value || value[0] !== '/' || value.startsWith('//') || value.includes('\\\\') || value.includes('#')) return '/';
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return '/';
      let path = url.pathname + url.search;
      if (base && (path === base || path.startsWith(base + '/'))) path = path.slice(base.length) || '/';
      return path;
    } catch { return '/'; }
  };
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const next = params.get('next') || '/';
  history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
  if (!code || !state || !saved || saved.state !== state || typeof saved.verifier !== 'string' || typeof saved.expires !== 'number' || saved.expires < Date.now()) { fail(); return; }
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  post('/api/desktop/exchange', { state, code, verifier: saved.verifier })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('exchange rejected')))
    .then(result => post('/api/auth/one-time-token/verify', { token: result.token }))
    .then(response => {
      if (!response.ok) throw new Error('token rejected');
      try { sessionStorage.removeItem(key); } catch {}
      const path = safeNext(next);
      location.replace(base ? base + (path === '/' ? '' : path) : path);
    })
    .catch(fail);
})()
</script></html>`
  return new Response(html, { headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
}
