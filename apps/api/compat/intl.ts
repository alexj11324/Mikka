// Compatibility alias for the server build graph only (see compat-aliases.mjs).
// The implementation lives in lib/intl/i18n-server.ts so application code can
// import it directly; this file keeps the historical alias target working
// until every importer has moved.
export { getLocale, getMessages, getRequestConfig, getTranslations, setRequestLocale } from '../../../lib/intl/i18n-server'
