const PATH = '/mikka/cloud/v1/models/chat/completions'
const numeric = ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed']
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : typeof value === 'number' ? 'number' : 'other'
const validName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** Fixture-only structural metadata. Never read a response, prompt, tool
 * description, argument value, header or credential into diagnostic output. */
export function installModelWireDiagnostics(target = globalThis, write = value => console.log(JSON.stringify(value))) {
  const original = target.fetch
  target.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.origin === 'https://app.aspectlylabs.com' && url.pathname === PATH) {
        const bodyKind = typeof init?.body === 'string' ? 'string' : init?.body == null ? 'none' : 'other'
        const record = { kind: 'closeout_model_wire_shape', version: 1, bodyKind, parsed: false }
        if (bodyKind === 'string' && Buffer.byteLength(init.body) <= 16 * 1024 * 1024) {
          const body = JSON.parse(init.body)
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            record.parsed = true
            record.modelMatches = body.model === 'deepseek/deepseek-v4.1-flash'
            record.messageCount = Array.isArray(body.messages) ? body.messages.length : -1
            record.toolCount = Array.isArray(body.tools) ? body.tools.length : body.tools === undefined ? 0 : -1
            record.invalidToolNames = Array.isArray(body.tools) ? body.tools.filter(t => !validName(t?.function?.name)).length : 0
            record.invalidToolSchemas = Array.isArray(body.tools) ? body.tools.filter(t => !t?.function?.parameters || typeof t.function.parameters !== 'object' || Array.isArray(t.function.parameters)).length : 0
            record.nonFunctionTools = Array.isArray(body.tools) ? body.tools.filter(t => t?.type !== 'function').length : 0
            record.numericTypes = Object.fromEntries(numeric.map(name => [name, kind(body[name])]))
            record.maxTokens = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? body.max_tokens : null
            record.maxCompletionTokens = typeof body.max_completion_tokens === 'number' && Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : null
            record.stream = typeof body.stream === 'boolean' ? body.stream : null
            record.roles = Object.fromEntries(['system', 'developer', 'user', 'assistant', 'tool', 'other'].map(role => [role,
              Array.isArray(body.messages) ? body.messages.filter(m => role === 'other' ? !['system', 'developer', 'user', 'assistant', 'tool'].includes(m?.role) : m?.role === role).length : 0]))
            record.nonStringSystemMessages = Array.isArray(body.messages) ? body.messages.filter(m => ['system', 'developer'].includes(m?.role) && typeof m.content !== 'string').length : 0
          }
        }
        write(record)
      }
    } catch { /* Diagnostic errors cannot change the original request. */ }
    return original.call(this, input, init)
  }
  return () => { target.fetch = original }
}
if (process.env.MIKKA_MODEL_WIRE_DIAGNOSTICS === '1') installModelWireDiagnostics()
