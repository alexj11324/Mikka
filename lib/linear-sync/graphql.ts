import 'server-only'

export class LinearApiError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message)
    this.name = 'LinearApiError'
  }
}

export function sanitizeLinearError(value: string) {
  return Array.from(value, character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127 ? ' ' : character
  }).join('').slice(0, 300)
}

export async function linearGraphQL<T>(accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new LinearApiError('Linear could not be reached', true)
  }

  let result: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] }
  try {
    result = await response.json()
  } catch {
    throw new LinearApiError('Linear returned an invalid response', response.status >= 500, response.status)
  }

  const error = result.errors?.[0]
  if (!response.ok || error || result.data === undefined) {
    const code = error?.extensions?.code
    const message = sanitizeLinearError(error?.message ?? `Linear request failed (${response.status})`)
    throw new LinearApiError(message, response.status >= 500 || response.status === 429 || code === 'RATELIMITED', response.status)
  }
  return result.data
}
