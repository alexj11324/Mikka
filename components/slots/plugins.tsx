// The default plugins slot (docs/ui-overlay.md): none. The rail's 插件 page is today's store
// (components/plugins/plugins-view.tsx); a layer that draws its own page exports a component here.
import type { ComponentType } from 'react'
import type { PluginsPageProps } from './plugins-contract'

export const PluginsPage: ComponentType<PluginsPageProps> | null = null
