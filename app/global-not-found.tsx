/* i18n-ignore-file: rendered outside the locale segment, so next-intl is unavailable */
import type { Metadata } from 'next'
import Link from 'next/link'

import './globals.css'

export const metadata: Metadata = {
  title: '404 · Mikka',
}

/**
 * The root layout lives in `app/[locale]`, so unmatched top-level paths have
 * no layout to render. This file must be a complete HTML document and cannot
 * use next-intl (there is no request locale outside `[locale]`).
 */
export default function GlobalNotFound() {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">404</p>
          <h1 className="text-2xl font-semibold">页面不存在 · Page not found</h1>
          <p className="text-sm text-muted-foreground">你访问的页面不存在或已被移动。 · The page you are looking for does not exist.</p>
          <Link href="/" className="text-sm underline underline-offset-4">返回工作台 · Back to workspace</Link>
        </main>
      </body>
    </html>
  )
}
