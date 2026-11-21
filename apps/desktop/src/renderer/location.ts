/**
 * The desktop window's router state, owned by the shared client runtime so Web
 * and Desktop cannot drift on which URLs the application handles.
 *
 * This module stays as the renderer's entry point; `installNavigation` and the
 * hooks live in `lib/client-runtime/location.ts`.
 */
export * from '@/lib/client-runtime/location'
