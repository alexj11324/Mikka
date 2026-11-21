/**
 * The application's translation entry point for components, hooks and tests.
 *
 * `next-intl`'s client surface was a thin wrapper over `use-intl`: its
 * `index.react-client.js` re-exports `use-intl/react` and `use-intl/core`, and
 * only adds a `try/catch` that rewrites message errors. The application keeps
 * the direct `use-intl` API — every hook here has the same name and signature —
 * so the framework dependency is not needed at runtime.
 *
 * Import from this module instead of a package, so a future change touches one
 * file. Types are augmented in `i18n/global.ts`.
 */
export {
  IntlProvider,
  IntlProvider as NextIntlClientProvider,
  useFormatter,
  useLocale,
  useMessages,
  useNow,
  useTimeZone,
  useTranslations,
} from 'use-intl/react'

export { createFormatter, createTranslator, hasLocale } from 'use-intl/core'
export type { AppConfig, DateTimeFormatOptions, Messages, NamespaceKeys, NestedKeyOf } from 'use-intl/core'
