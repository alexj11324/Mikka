/**
 * The Coordinator's model, through Vercel AI Gateway. On Vercel the gateway
 * signs in with the deployment's OIDC token; elsewhere set AI_GATEWAY_API_KEY.
 */
export const COORDINATOR_MODEL = 'deepseek/deepseek-v4.1-flash-1017'

/** Tool-call rounds the Coordinator may take to answer one batch of messages. */
export const COORDINATOR_MAX_STEPS = 20
