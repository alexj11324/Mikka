/** Shared browser/server computer contract. */
export * from '@mikka/protocol/computer'

/** A host the 添加设备 dialog offers: from the user's ~/.ssh/config or their Tailnet. */
export type KnownHost = { alias: string; hostName?: string; user?: string; source: 'ssh' | 'tailnet'; configured: boolean }

export type SetupStep = 'login' | 'check' | 'install' | 'start' | 'connect'
export type SetupStepState = 'idle' | 'active' | 'done' | 'failed'
export const SETUP_STEPS: SetupStep[] = ['login', 'check', 'install', 'start', 'connect']
