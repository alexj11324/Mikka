import { z } from 'zod'
import { TOOLKIT_SLUG } from '@/lib/composio-accounts'
import { isCredentialScheme, readCredentials, type CredentialForm, type CredentialScheme } from './connect-kind'
import { PluginError } from './contracts'

// Connecting an app with the person's own credentials (decision 2026-11-02).
// The values go from the request straight to Composio, which keeps them with
// the connected account; Mikka stores none of them, logs none of them and
// returns none of them. The account belongs to the signed-in person, like an
// OAuth connection, and the existing list, switch, rename, default and
// disconnect apply to it. Pure: Composio comes in as deps.

export const credentialConnectInput = z.object({
  toolkit: z.string().regex(TOOLKIT_SLUG),
  scheme: z.string().refine(isCredentialScheme),
  fields: z.record(z.string(), z.unknown()),
  /** Replace this account of the person's (a new key); it is retired once the new one is active. */
  replaceAccountId: z.string().trim().min(1).max(255).optional(),
}).strict()

export type CredentialConnectDeps = {
  /** Composio's form for this toolkit and scheme, or null when the app does not connect with the person's credentials. */
  form: (toolkit: string, scheme: CredentialScheme) => Promise<CredentialForm | null>
  /** Mikka's auth config for the toolkit and scheme (no credentials of its own), created once and reused. */
  authConfig: (toolkit: string, scheme: CredentialScheme) => Promise<string>
  /** Creates the person's connected account with these values; returns its id and status. */
  initiate: (userId: string, authConfigId: string, scheme: CredentialScheme, values: Record<string, string>) => Promise<{ id: string; status: string }>
  /** The person's own account with this id on this toolkit, or null. */
  ownAccount: (userId: string, accountId: string, toolkit: string) => Promise<{ id: string } | null>
  /** Retires the replaced account and carries its name and default to the new one. */
  replace: (userId: string, addedId: string, replacedId: string) => Promise<void>
}

export async function connectWithCredentials(deps: CredentialConnectDeps, userId: string, raw: unknown): Promise<{ accountId: string }> {
  const parsed = credentialConnectInput.safeParse(raw)
  if (!parsed.success) throw new PluginError('invalidIntegration', 400)
  const { toolkit, fields } = parsed.data
  const scheme = parsed.data.scheme as CredentialScheme
  const form = await deps.form(toolkit, scheme)
  if (!form) throw new PluginError('integrationToolkitNotSupported', 400)
  const values = readCredentials(form, fields)
  if (!values) throw new PluginError('invalidCredentials', 400)
  const replacing = parsed.data.replaceAccountId ? await deps.ownAccount(userId, parsed.data.replaceAccountId, toolkit) : null
  if (parsed.data.replaceAccountId && !replacing) throw new PluginError('integrationNotFound', 404)
  let account: { id: string; status: string }
  try {
    account = await deps.initiate(userId, await deps.authConfig(toolkit, scheme), scheme, values)
  } catch {
    // Never pass Composio's message on: it may quote what was submitted.
    throw new PluginError('integrationConnectFailed', 502)
  }
  if (account.status !== 'ACTIVE') throw new PluginError('integrationConnectFailed', 502)
  if (replacing) await deps.replace(userId, account.id, replacing.id)
  return { accountId: account.id }
}

/** Mikka's own auth config for a toolkit and scheme: found by name, else created with no credentials of its own. */
export const authConfigName = (toolkit: string, scheme: CredentialScheme) => `mikka-${toolkit}-${scheme.toLowerCase()}`.slice(0, 100)
