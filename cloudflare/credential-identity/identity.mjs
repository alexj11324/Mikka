const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
const encoder = new TextEncoder()

function configuration(env) {
  const issuer = new URL(env.ISSUER_URL)
  if (typeof env.ISSUER_URL !== 'string' || issuer.protocol !== 'https:' ||
      ![issuer.origin, `${issuer.origin}/`].includes(env.ISSUER_URL) ||
      typeof env.CREDENTIAL_ENVIRONMENT !== 'string' || !env.CREDENTIAL_ENVIRONMENT ||
      typeof env.SIGNING_KEY_ID !== 'string' || !env.SIGNING_KEY_ID.trim()) {
    throw new Error('Invalid identity configuration')
  }
  return { issuer: issuer.origin, environment: env.CREDENTIAL_ENVIRONMENT, kid: env.SIGNING_KEY_ID }
}

async function publicKey(env, kid) {
  const jwk = JSON.parse(env.SIGNING_PUBLIC_JWK)
  const fields = ['kty', 'n', 'e', 'kid', 'alg', 'use']
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk) ||
      Object.keys(jwk).length !== fields.length ||
      !fields.every(field => typeof jwk[field] === 'string') ||
      jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || jwk.kid !== kid ||
      !/^[A-Za-z0-9_-]+$/.test(jwk.n) || !/^[A-Za-z0-9_-]+$/.test(jwk.e)) {
    throw new Error('Invalid public identity key')
  }
  const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify'])
  if (key.algorithm.modulusLength < 2048) throw new Error('Invalid public identity key')
  return { jwk, key }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function runtimeIdentityMetadata(env) {
  try {
    const { issuer, kid } = configuration(env)
    const { jwk } = await publicKey(env, kid)
    return {
      configuration: {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
      jwks: { keys: [jwk] },
    }
  } catch {
    throw new Error('Runtime identity unavailable')
  }
}

export async function issueRuntimeIdentity(role, env) {
  try {
    if (role !== 'app' && role !== 'broker') throw new Error('Invalid identity role')
    const { issuer, environment, kid } = configuration(env)
    const { key: verificationKey } = await publicKey(env, kid)
    const pem = await env.SIGNING_KEY.get()
    const match = typeof pem === 'string' && pem.match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/)
    if (!match) throw new Error('Invalid signing key')
    const der = Uint8Array.from(atob(match[1].replace(/\s/g, '')), char => char.charCodeAt(0))
    const signingKey = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign'])
    const iat = Math.floor(Date.now() / 1000)
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })))
    const payload = base64url(encoder.encode(JSON.stringify({
      iss: issuer,
      sub: `cloudflare:mikka:${role}:${environment}`,
      aud: 'sts.amazonaws.com',
      iat,
      exp: iat + 300,
    })))
    const message = encoder.encode(`${header}.${payload}`)
    const signature = await crypto.subtle.sign(algorithm, signingKey, message)
    // Refuse a token when the separately delivered public and private keys disagree.
    if (!await crypto.subtle.verify(algorithm, verificationKey, signature, message)) {
      throw new Error('Signing key mismatch')
    }
    return `${header}.${payload}.${base64url(signature)}`
  } catch {
    throw new Error('Runtime identity unavailable')
  }
}
