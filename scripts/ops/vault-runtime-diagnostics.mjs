// Read-only fixture observer. Returns the original fetch Promise and Response;
// no capability query, headers, body, browser contents or credentials are read.
if (process.env.MIKKA_VAULT_DIAGNOSTICS === '1') {
  const original = globalThis.fetch
  globalThis.fetch = function(input, init) {
    let route
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const match = /^\/agents\/[a-f0-9-]{36}\/(start|stop|state|action|credentials\/(?:observe|begin|end|continue))$/.exec(url.pathname)
      if (url.protocol === 'https:' && url.hostname.endsWith('.e2b.app') && match) route = match[1]
    } catch {}
    const promise = original.call(this, input, init)
    if (route) void promise.then(response => {
      console.log(JSON.stringify({ kind: 'vault_runtime_boundary', route, status: response.status }))
    }, error => {
      console.log(JSON.stringify({ kind: 'vault_runtime_boundary', route, error: ['AbortError','TimeoutError','TypeError'].includes(error?.name) ? error.name : 'other' }))
    }).catch(() => {})
    return promise
  }
}
