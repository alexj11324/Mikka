/** Sections reachable through the dev-only settings harness (server-safe constant). */
export const SETTINGS_HARNESS_SECTIONS = ['bots'] as const
export type SettingsHarnessSection = (typeof SETTINGS_HARNESS_SECTIONS)[number]
