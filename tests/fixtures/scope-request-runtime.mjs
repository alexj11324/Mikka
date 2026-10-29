// Node action tests have no Next request/intl compiler context. Replace only
// that framework boundary; auth, ACLs, DB transactions and dispatch stay real.
import './team-auth-runtime.mjs'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return { url: 'scope-request-fixture:intl', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'scope-request-fixture:intl') return { format: 'module', source: 'export async function getLocale(){return "en"} export async function getTranslations(){return key=>key}', shortCircuit: true }
    return next(url, context)
  },
})
