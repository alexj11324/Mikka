// What the plugins slot receives (docs/ui-overlay.md): nothing. The rail's 插件 page reads and acts through
// usePluginsView, usePluginStore and useSkillsSearch, and draws an app's own page (`&app=`) with the shared
// PluginAppPage (components/plugins/plugins-view.tsx).
export type PluginsPageProps = Record<never, never>
