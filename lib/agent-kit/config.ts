/** Versioned definitions are on by default; operators retain an explicit kill switch. */
export function agentKitEnabled(): boolean { return process.env.MIKKA_AGENT_KIT !== '0' }
