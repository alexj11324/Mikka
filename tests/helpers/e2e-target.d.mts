export const E2E_DB_RULE: string
export function isE2eTarget(value: string | undefined | null): boolean
export function assertE2eTarget(value: string | undefined | null): URL
export const APPLICATION_DATABASE_URLS: readonly string[]
export function disposableDatabase(env?: Readonly<Record<string, string | undefined>>, ...urls: (string | undefined | null)[]): boolean
