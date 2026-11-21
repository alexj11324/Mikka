import type { PluginsPageProps } from './plugins-contract'

/** Public build-time contract. The official renderer links the provider. */
export function PluginsPage(_props: PluginsPageProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: plugins')
}
