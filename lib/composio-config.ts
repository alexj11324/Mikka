export function composioCallbackVerifierURL(baseURL: string | undefined, basePath = '') {
  if (!baseURL) return undefined
  try {
    return new URL(`${basePath.replace(/\/$/, '')}/api/integrations/composio/callback`, new URL(baseURL).origin).toString()
  } catch {
    return undefined
  }
}

export function isComposioCallbackVerifierConfigured(baseURL: string | undefined, basePath = '') {
  const expected = composioCallbackVerifierURL(baseURL, basePath)
  return Boolean(expected && process.env.COMPOSIO_CALLBACK_VERIFIER_URL === expected)
}
