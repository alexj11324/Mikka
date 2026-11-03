import type { PoolConfig } from 'pg'
export function directDatabaseURL<T extends string | undefined | null>(value: T): T
export function directPoolOptions(options: PoolConfig): PoolConfig
