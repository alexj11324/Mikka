import { notFound } from 'next/navigation'

// Without this catch-all, unknown paths under a locale never enter the
// [locale] segment and fall through to the static global-not-found page.
export default function CatchAll() {
  notFound()
}
