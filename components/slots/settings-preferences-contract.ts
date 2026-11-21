// Preferences and Threads share this slot; their existing hooks own reads and saves.

export type SettingsPreferencesProps =
  | { page?: 'preferences' }
  | { page: 'threads'; workspaceId: string; workspaceName?: string }
