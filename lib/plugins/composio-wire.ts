// `@composio/core` ≥ 0.26 rewrites toolkit payloads to camelCase
// (`composio_managed_auth_schemes` → `composioManagedAuthSchemes`, and every
// sibling field the same way) while this pipeline reads the REST wire shape.
// Nothing renames them back, so `toolkits.list`/`retrieve` results used to
// arrive with every managed-auth flag missing and managed apps read as
// "unsupported" (#1920). `wire` puts the wire names back at the boundary so
// the rest of the pipeline keeps one spelling. Recursion is bounded by the
// payload itself.

const WIRE_KEY: Record<string, string> = {
  isLocalToolkit: 'is_local_toolkit',
  noAuth: 'no_auth',
  composioManagedAuthSchemes: 'composio_managed_auth_schemes',
  authSchemes: 'auth_schemes',
  authConfigDetails: 'auth_config_details',
  authConfigCreation: 'auth_config_creation',
  connectedAccountInitiation: 'connected_account_initiation',
  authGuideUrl: 'auth_guide_url',
  authHintUrl: 'auth_hint_url',
  isSecret: 'is_secret',
  userVisible: 'user_visible',
  legacyTemplateName: 'legacy_template_name',
  requiredScopes: 'required_scopes',
  availableVersions: 'available_versions',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  appUrl: 'app_url',
  toolsCount: 'tools_count',
  triggersCount: 'triggers_count',
  isDeprecated: 'is_deprecated',
  nextCursor: 'next_cursor',
  baseUrl: 'base_url',
}

export function wire<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => wire(item)) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[WIRE_KEY[key] ?? key] = wire(entry)
  return out as T
}
