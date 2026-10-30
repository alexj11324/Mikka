import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SettingsHarness } from '@/components/settings/settings-harness'
import { SETTINGS_HARNESS_SECTIONS, type SettingsHarnessSection } from '@/lib/settings/harness-sections'

/**
 * DEV-ONLY test entry for settings v4 pages that are not wired into
 * settings-view.tsx yet. Renders a page against its typed mock adapter.
 * 404 unless the server runs with MIKKA_SETTINGS_HARNESS=1; remove once the
 * pages are wired after #431 merges.
 */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function SettingsHarnessPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ state?: string }> }) {
  if (process.env.MIKKA_SETTINGS_HARNESS !== '1') notFound()
  const { section } = await params
  if (!(SETTINGS_HARNESS_SECTIONS as readonly string[]).includes(section)) notFound()
  const { state } = await searchParams
  return <SettingsHarness section={section as SettingsHarnessSection} state={state ?? 'default'} />
}
