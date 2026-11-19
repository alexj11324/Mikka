/**
 * The localized navigation surface (`Link`, `useRouter`, `usePathname`,
 * `getPathname`, `redirect`) that client application code imports.
 *
 * The bundler resolves this specifier to `lib/client-runtime/localized-navigation.tsx`,
 * and this module re-exports the same shape for TypeScript and for Node tests,
 * so the specifier resolves without a framework package.
 *
 * Server code must not import this: it would pull React hooks and the
 * `window`-bound router into the server graph, and its `getPathname` differs
 * from the server implementation (a root href keeps a trailing slash). Import
 * `@/lib/server-runtime/localized-navigation` instead.
 */
export { Link, getPathname, redirect, usePathname, useRouter } from '../lib/client-runtime/localized-navigation'
