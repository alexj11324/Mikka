'use client'

import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The sign-in card's frame for the single-purpose auth screens: password
// recovery and email verification.
export function AuthCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="w-full max-w-[26rem] overflow-hidden p-0">
      <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-2xl font-semibold tracking-tight text-balance">
            <h1>{title}</h1>
          </CardTitle>
          {description && <CardDescription className="text-pretty">{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-7 pb-7 sm:px-9 sm:pb-8">
        {children}
      </CardContent>
    </Card>
  )
}
