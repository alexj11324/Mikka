// Playwright errors may embed a loopback URL or browser request. Keep raw
// authentication material out of CI logs while retaining the useful failure.
const allowed = new Set(['bundled-smoke', 'parity', 'lifecycle', 'idle'])
const names = process.argv.slice(2)
if (!names.length || names.some(name => !allowed.has(name))) throw new Error('DESKTOP_ACCEPTANCE_SCRIPT_REQUIRED')
for (const name of names) {
  try {
    await import(new URL(`./${name}.mjs`, import.meta.url).href)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown acceptance failure'
    const safe = message.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[request URL]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(token|password|code|state)=([^\s&,]+)/gi, '$1=[redacted]')
    console.error(`Desktop ${name} failed: ${safe.slice(0, 2500)}`)
    process.exitCode = 1
    break
  }
}
