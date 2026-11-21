/**
 * `server-only` is a marker package, not a runtime dependency: importing it
 * makes a module fail to bundle for the client. The declaration used to arrive
 * with Next's type plugin; the app no longer builds on Next, so it is declared
 * here instead.
 */
declare module 'server-only'
