import 'server-only'
import { computeDiscoveryUrl, fetchDiscoveryDocument, normalizeDiscoveryUrls, selectTokenEndpointAuthMethod, validateDiscoveryDocument, validateDiscoveryUrl } from '@better-auth/sso'

/** The native hydrated config omits logout metadata. Normalize one native-validated
 * discovery snapshot for both sign-in and RP-initiated logout. */
export async function discoverEnterpriseOidcConfig(issuer: string, tokenEndpointAuthentication: 'client_secret_basic' | 'client_secret_post') {
  const issuerOrigin = new URL(issuer).origin
  const isTrustedOrigin = (url: string) => new URL(url).origin === issuerOrigin
  const discoveryEndpoint = computeDiscoveryUrl(issuer)
  validateDiscoveryUrl(discoveryEndpoint, isTrustedOrigin)
  const document = await fetchDiscoveryDocument(discoveryEndpoint, 10_000, isTrustedOrigin)
  validateDiscoveryDocument(document, issuer)
  const normalized = normalizeDiscoveryUrls(document, issuer, isTrustedOrigin)
  return {
    issuer: normalized.issuer, discoveryEndpoint,
    authorizationEndpoint: normalized.authorization_endpoint, tokenEndpoint: normalized.token_endpoint,
    jwksEndpoint: normalized.jwks_uri, userInfoEndpoint: normalized.userinfo_endpoint,
    tokenEndpointAuthentication: selectTokenEndpointAuthMethod(normalized, tokenEndpointAuthentication),
    scopesSupported: normalized.scopes_supported,
    endSessionEndpoint: normalized.end_session_endpoint,
  }
}
