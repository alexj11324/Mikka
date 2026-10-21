import { NextResponse } from 'next/server'
import { loadWorkspaceSwitcher } from '@/lib/workspace-switcher'

export async function GET() {
  try {
    return NextResponse.json(await loadWorkspaceSwitcher(), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: '无法读取工作区，请确认登录状态后重试。' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
