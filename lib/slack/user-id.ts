export const slackUserId = (v: unknown): v is string => typeof v === 'string' && /^[UW][A-Z0-9]{1,40}$/.test(v)
