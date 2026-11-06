import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path => fileURLToPath(new URL(path, import.meta.url))

/** Only the independent server graph uses these adapters. The client has its
 * own Vite aliases and never receives headers, auth or database modules. */
export const apiAliases = {
  'next/server': here('./compat/server.ts'),
  'next/server.js': here('./compat/server.ts'),
  'next/headers': here('./compat/headers.ts'),
  'next/headers.js': here('./compat/headers.ts'),
  'next/navigation': here('./compat/navigation.ts'),
  'next-intl/server': here('./compat/intl.ts'),
  '@/i18n/navigation': here('./compat/localized-navigation.ts'),
  'server-only': here('./compat/server-only.ts'),
  'mikka-real-react': require.resolve('react'),
  react: here('./compat/react.ts'),
  '@': here('../..'),
}
