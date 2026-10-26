import { withRequestLog } from '@/lib/request-log'
import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { loadWorkspaceSwitcher } from '@/lib/workspace-switcher'

async function handleGET() {
  const i18nText = await getTranslations();
  try {
    return NextResponse.json(await loadWorkspaceSwitcher(), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: i18nText("FeatureCopy.c_6a0f7116") }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
  }
}

export const GET = withRequestLog('/api/workspace/switcher', handleGET)
