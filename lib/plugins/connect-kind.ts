// How a store app connects (decision 2026-11-02): Composio-managed OAuth in
// one click, the person's own credentials (an API key, a token, a login) in
// a form, or nothing at all. The form's fields are Composio's own definition
// for the toolkit; nothing here is written per app. Pure, shared by the
// catalog, the app page, the connect route and tests.

/** Credential schemes a person can fill in themselves. OAuth without Composio-managed auth needs a developer app, so it is not offered. */
export const CREDENTIAL_SCHEMES = ['API_KEY', 'BEARER_TOKEN', 'BASIC'] as const
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number]
export type ConnectKind = 'managed' | 'credentials' | 'none' | 'unsupported'

export const isCredentialScheme = (value: unknown): value is CredentialScheme => typeof value === 'string' && (CREDENTIAL_SCHEMES as readonly string[]).includes(value)

export function connectKind(item: { no_auth?: boolean | null; auth_schemes?: string[] | null; composio_managed_auth_schemes?: string[] | null }): ConnectKind {
  const schemes = item.auth_schemes ?? []
  if (item.no_auth || (schemes.length > 0 && schemes.every(scheme => scheme === 'NO_AUTH'))) return 'none'
  if ((item.composio_managed_auth_schemes?.length ?? 0) > 0) return 'managed'
  return schemes.some(isCredentialScheme) ? 'credentials' : 'unsupported'
}

export type CredentialField = { name: string; label: string; description: string; secret: boolean; required: boolean; defaultValue: string | null }
export type CredentialForm = { scheme: CredentialScheme; fields: CredentialField[] }

type RawField = { name?: unknown; displayName?: unknown; display_name?: unknown; description?: unknown; is_secret?: unknown; required?: unknown; default?: unknown; user_visible?: unknown; type?: unknown }
type RawDetail = { mode?: unknown; fields?: { connected_account_initiation?: { required?: RawField[] | null; optional?: RawField[] | null } | null } | null }

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** The forms Composio defines for a toolkit's credential schemes (`auth_config_details`), in Composio's order. */
export function credentialForms(details: unknown): CredentialForm[] {
  if (!Array.isArray(details)) return []
  const forms: CredentialForm[] = []
  for (const detail of details as RawDetail[]) {
    if (!isCredentialScheme(detail?.mode) || forms.some(form => form.scheme === detail.mode)) continue
    const initiation = detail.fields?.connected_account_initiation
    const fields: CredentialField[] = []
    for (const [list, required] of [[initiation?.required, true], [initiation?.optional, false]] as const) {
      for (const raw of list ?? []) {
        const name = typeof raw?.name === 'string' ? raw.name : ''
        if (!FIELD_NAME.test(name) || raw.user_visible === false || (raw.type !== undefined && raw.type !== 'string') || fields.some(field => field.name === name)) continue
        fields.push({
          name, label: clean(raw.displayName ?? raw.display_name, 120) || name, description: clean(raw.description, 300),
          secret: raw.is_secret === true, required: required && raw.required !== false,
          defaultValue: typeof raw.default === 'string' && raw.default.length <= 2048 ? raw.default : null,
        })
      }
    }
    if (fields.length) forms.push({ scheme: detail.mode, fields })
  }
  return forms
}

export const MAX_CREDENTIAL_CHARS = 4096

/**
 * What a person submitted, checked against Composio's form: only its fields,
 * strings within bounds, every required one present (its Composio default
 * when left empty). Null when it does not fit. The values are never logged.
 */
export function readCredentials(form: CredentialForm, raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !form.fields.some(field => field.name === key))) return null
  const values: Record<string, string> = {}
  for (const field of form.fields) {
    const value = input[field.name]
    if (value !== undefined && typeof value !== 'string') return null
    const text = (value ?? '').trim()
    if (text.length > MAX_CREDENTIAL_CHARS) return null
    const chosen = text || field.defaultValue || ''
    if (!chosen) { if (field.required) return null; continue }
    values[field.name] = chosen
  }
  return values
}
