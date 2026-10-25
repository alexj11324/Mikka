// Isolate framework sessions/background dispatch, not database/writer code.
// Actual actions, authorization, transactions, Drizzle and actor context run unchanged.
import { registerHooks } from 'node:module'
const sources = new Map([
  ['server-only', 'export {}'],
  ['next/headers', 'export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}'],
  ['next/server', 'export function after(){}'],
  ['next-intl/server', 'export async function getLocale(){return "en"} export async function getTranslations(){return (key)=>key}'],
])
const files = new Map([
  ['/lib/auth.ts', 'export const auth={api:{async getSession(){return null}}}'],
  ['/lib/linear-sync/dispatch.ts', 'export function dispatchLinearIssueSync(){} export function dispatchLinearWork(){}'],
  ['/lib/issue-scope-judge.ts', 'export async function judgeIssueScope(){}'],
  ['/lib/coordinator/wake.ts', 'export async function wakeCoordinator(){}'],
])
registerHooks({
  resolve(specifier, context, next) {
    if (sources.has(specifier)) return { url: `activity-fixture:${encodeURIComponent(sources.get(specifier))}`, shortCircuit: true }
    const resolved = next(specifier, context)
    for (const [suffix, code] of files) if (resolved.url.endsWith(suffix)) return { url: `activity-fixture:${encodeURIComponent(code)}`, shortCircuit: true }
    return resolved
  },
  load(url, context, next) {
    if (url.startsWith('activity-fixture:')) return { format: 'module', source: decodeURIComponent(url.slice('activity-fixture:'.length)), shortCircuit: true }
    return next(url, context)
  },
})
