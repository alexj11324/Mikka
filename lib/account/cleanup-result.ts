/** Cleanup failures block account deletion; third-party retention/revocation exceptions are disclosed separately. */
export interface AccountCleanupReport { blockedReasons: string[]; warnings: string[] }
