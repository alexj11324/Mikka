// The renderer's own import path for localized navigation. The implementation
// lives in the shared client runtime so Web, Desktop and the i18n entry point
// resolve the same module.
export { Link, getPathname, redirect, usePathname, useRouter } from '@/lib/client-runtime/localized-navigation'
