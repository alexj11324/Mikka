import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { getLocale, getTranslations } from 'next-intl/server'

import { OAuthConsent } from '@/components/oauth-consent'
import { redirect } from '@/i18n/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { oauthClients } from '@/lib/db/schema'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('oauthConsentTitle'), description: t('oauthConsentDescription') }
}

/**
 * Where the OAuth server (lib/auth.ts) sends the person when an agent asks to
 * act as them, e.g. Claude Code connecting to the MCP server. The query is the
 * signed authorization request; the client component sends it back with the
 * answer.
 */
export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  const locale = await getLocale()
  if (!session?.user) redirect({ href: '/sign-in', locale })
  const clientId = typeof query.client_id === 'string' ? query.client_id : ''
  const [client] = clientId ? await db.select({ name: oauthClients.name, uri: oauthClients.uri }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1) : []
  return <OAuthConsent clientName={client?.name || null} clientUri={client?.uri || null} account={session!.user.email} />
}
