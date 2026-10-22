import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { loadWorkspaceSwitcher } from '@/lib/workspace-switcher'

export async function GET() {
  const i18nText = await getTranslations();
  try {
    return NextResponse.json(await loadWorkspaceSwitcher(), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: i18nText("FeatureCopy.c_6a0f7116") }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
