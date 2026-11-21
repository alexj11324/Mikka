/**
 * A compile-time boundary marker: a module that imports it can never be part of
 * the browser bundle.
 *
 * This is the repository's own marker, not an npm package. The API build aliases
 * the bare `server-only` specifier here, and the web build independently rejects
 * any module that resolves to this file (see application-plugin.mjs).
 */
export {}
