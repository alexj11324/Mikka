// TEMPORARY issue #1512 diagnosis. Only lifecycle enables the child flag.
import { createReadDiagnosticCollector, reviewReadDiagnosticCollection, validateReadDiagnosticCollection } from '../../../lib/diagnostics/issue1512-read-collector.mjs'
import { validateReadDiagnosticDump } from '../../../lib/diagnostics/issue1512-native-reads.mjs'
export const nativeReadDiagnosticEnabled = process.env.MIKKA_1512_LIFECYCLE_READ_DIAGNOSTIC === '1'

const project = (raw, current) => {
  if (!validateReadDiagnosticCollection(raw) || (current !== null && !validateReadDiagnosticDump(current))) return {
    version: 1, status: 'incomplete', reasons: [14], raw: null, current: null,
  }
  return { version: 1, ...reviewReadDiagnosticCollection(raw, current), raw, current }
}
export async function attachWebReadDiagnostic(page) {
  if (!nativeReadDiagnosticEnabled) return null
  const collector = createReadDiagnosticCollector()
  page.on('domcontentloaded', collector.document)
  page.on('console', message => { collector.consoleMessage(message.text()) })
  await page.addInitScript(() => {
    if (window.top === window) Object.defineProperty(globalThis, '__mikka1512ReadDiagnosticEnabled', { value: true, configurable: false, writable: false })
  })
  return collector
}
export async function collectWebReadDiagnostic(page, collector) {
  try {
    const current = await page.evaluate(() => globalThis.__mikka1512ReadDiagnostic?.dump(2) ?? null)
    return project(collector.snapshot(), current)
  } catch { return { version: 1, status: 'incomplete', reasons: [15], raw: null, current: null } }
}
export async function collectNativeReadDiagnostic(app, current) {
  try {
    const raw = await app.evaluate(() => globalThis.__mikka1512ReadDiagnosticMain?.snapshot() ?? null)
    return project(raw, current ?? null)
  } catch { return { version: 1, status: 'incomplete', reasons: [15], raw: null, current: null } }
}
