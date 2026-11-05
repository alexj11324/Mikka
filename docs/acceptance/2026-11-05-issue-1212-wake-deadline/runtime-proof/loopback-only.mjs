const original = globalThis.fetch
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('wake_runtime_proof_external_fetch_forbidden')
  }
  return original.call(this, input, init)
}
