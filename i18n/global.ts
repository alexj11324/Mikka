import messages from '../messages/en.json'
import { routing } from './routing'

/**
 * The application's message catalog and locale union, so `useTranslations`
 * rejects a namespace or key that does not exist.
 *
 * `use-intl` declares `AppConfig` in its `core` entry and re-exports it from the
 * package root; TypeScript only merges the declaration through the module that
 * declares it, so the augmentation names `use-intl/core`.
 */
declare module 'use-intl/core' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number]
    Messages: typeof messages
  }
}
