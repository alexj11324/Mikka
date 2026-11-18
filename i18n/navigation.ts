/**
 * The localized navigation surface (`Link`, `useRouter`, `usePathname`,
 * `getPathname`, `redirect`) that application code imports as
 * `@/i18n/navigation`.
 *
 * The bundler resolves this specifier to the platform's own implementation
 * (`apps/desktop/src/renderer/i18n-navigation.tsx` for Web and Desktop, and
 * `apps/api/compat/localized-navigation.ts` on the server). This module exists
 * for TypeScript and for Node tests, so the specifier still resolves without a
 * framework package, and it re-exports the same shape.
 */
export { Link, getPathname, redirect, usePathname, useRouter } from '../apps/desktop/src/renderer/i18n-navigation'
