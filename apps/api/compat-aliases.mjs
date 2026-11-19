import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path => fileURLToPath(new URL(path, import.meta.url))

/** Only the independent server graph uses these adapters. The client has its
 * own Vite aliases and never receives headers, auth or database modules.
 *
 * Application code imports `@/lib/server-runtime/*` and `@/lib/intl/*`
 * directly. No framework specifier is aliased: a leftover entry would shadow
 * the application's own modules, and the API build contract rejects one. */
export const apiAliases = {
  'server-only': here('../../lib/server-only.ts'),
  'mikka-real-react': require.resolve('react'),
  react: here('../../lib/server-runtime/react.ts'),
  '@': here('../..'),
}
