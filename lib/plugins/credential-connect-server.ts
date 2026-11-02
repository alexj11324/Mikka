import 'server-only'
import { AuthScheme } from '@composio/core'
import { getComposio, readComposioAccountEmail, renameComposioAccount, retireComposioAccount } from '@/lib/composio'
import { chooseComposioDefault, listComposioAccountRecords, noteComposioEmailAttempt, saveComposioAccountEmail } from '@/lib/composio-account-store'
import { followUpComposioConnect } from '@/lib/composio-connect'
import { listComposioPages } from '@/lib/composio-pagination'
import { composioAppDetailSource, readAppDetail } from './app-detail'
import type { CredentialScheme } from './connect-kind'
import { authConfigName, type CredentialConnectDeps } from './credential-connect'

type Client = NonNullable<ReturnType<typeof getComposio>>
type AuthConfigItem = { id?: string; name?: string; authScheme?: string; status?: string; isComposioManaged?: boolean }

const configs = new Map<string, Promise<string>>()

/** Mikka's auth config for a toolkit and scheme (no credentials of its own), found by name or created once per server. */
function authConfigFor(client: Client, toolkit: string, scheme: CredentialScheme) {
  const name = authConfigName(toolkit, scheme)
  const known = configs.get(name)
  if (known) return known
  const value = (async () => {
    const listed = await client.authConfigs.list({ toolkit, isComposioManaged: false, limit: 100 }) as { items?: AuthConfigItem[] }
    const found = listed.items?.find(item => item.name === name && item.authScheme === scheme && item.status !== 'DISABLED' && item.id)
    if (found?.id) return found.id
    const created = await client.authConfigs.create(toolkit, { type: 'use_custom_auth', name, authScheme: scheme, credentials: {} } as never) as { id: string }
    return created.id
  })()
  configs.set(name, value)
  value.catch(() => { if (configs.get(name) === value) configs.delete(name) })
  return value
}

function stateFor(scheme: CredentialScheme, values: Record<string, string>) {
  return scheme === 'API_KEY' ? AuthScheme.APIKey(values as never) : scheme === 'BEARER_TOKEN' ? AuthScheme.BearerToken(values as never) : AuthScheme.Basic(values as never)
}

export function credentialConnectDeps(client: Client): CredentialConnectDeps {
  return {
    form: async (toolkit, scheme) => {
      const detail = await readAppDetail(composioAppDetailSource(client), toolkit)
      return detail.auth.kind === 'credentials' ? detail.auth.forms.find(form => form.scheme === scheme) ?? null : null
    },
    authConfig: (toolkit, scheme) => authConfigFor(client, toolkit, scheme),
    initiate: async (userId, authConfigId, scheme, values) => {
      // A second account on the same app (a new key, or another login) is allowed, as with OAuth.
      const request = await client.connectedAccounts.initiate(userId, authConfigId, { config: stateFor(scheme, values), allowMultiple: true } as never) as { id: string; status?: string }
      return { id: request.id, status: request.status ?? 'ACTIVE' }
    },
    ownAccount: async (userId, accountId, toolkit) => {
      const items = await listComposioPages(cursor => client.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit], cursor }))
      const own = items.find(item => item.id === accountId && item.toolkit.slug === toolkit)
      return own ? { id: own.id } : null
    },
    replace: async (userId, addedId, replacedId) => {
      const [items, records] = await Promise.all([listComposioPages(cursor => client.connectedAccounts.list({ userIds: [userId], cursor })), listComposioAccountRecords(userId)])
      await followUpComposioConnect({ items, records, addedId, replaceId: replacedId }, {
        readEmail: (toolkit, accountId) => readComposioAccountEmail(client, userId, toolkit, accountId),
        saveEmail: (toolkit, accountId, email) => saveComposioAccountEmail(userId, toolkit, accountId, email),
        noteAttempt: (toolkit, accountId) => noteComposioEmailAttempt(userId, toolkit, accountId),
        rename: (accountId, alias) => renameComposioAccount(client, accountId, alias),
        retire: accountId => retireComposioAccount(client, userId, accountId, 'replace'),
        chooseDefault: (toolkit, accountId) => chooseComposioDefault(userId, toolkit, accountId),
        log: (step, error) => console.error('Composio key replace follow-up failed', { step, error: error instanceof Error ? error.name : 'unknown' }),
      })
    },
  }
}
