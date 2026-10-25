# BYOS shared server identity compatibility

The server-only `MIKKA_BYOS_SHARED_IDENTITY=1` setting permits existing custody,
access and transfer-source client ID fields to name the same identity. No other
value enables this mode. Each role still requires its own explicit ID/secret
fields; there is no admin/static-token fallback. Default configuration continues
to require separated identities. Three independent logical caches remain, even
if the server issues identical token strings. A source denial cannot invalidate
the destination cache. Disabling shared mode fences access/source on next use.

This does not restrict the actual identity's vault permissions. An admin bearer
can access everything its server-side role permits, regardless of the app's
configured paths. In shared mode the access worker receives that broad bearer,
not a vault-enforced read-only credential. The native CLI/model/browser does not
receive it; compromise of the trusted app or worker has the identity's full blast
radius. Owner/workspace/path/epoch checks are unchanged. No production setting
was changed by this patch.

## Token lifetime remains blocked

Official Universal Auth login reference lists clientId, clientSecret and optional
organizationSlug, with no per-login TTL override:
https://infisical.com/docs/api-reference/endpoints/universal-auth/login

The existing reported 2592000-second token is still rejected by the unchanged
3600-second ceiling. Local caching cannot shorten server validity. No invented
TTL request field, token exchange, revoke loop or retry of the denied auth-config
GET was introduced. This is not a deployable solution to the TTL mismatch alone.

Release owner needs one explicit operational choice before activation:
- Authorized change of the existing identity's server-side auth TTL/maxTTL to a
  short duration (proposed600s), with review of effects on its other consumers;
  current configuration GET403 must not be bypassed.
- Explicit acceptance of a30-day admin bearer and a separately reviewed lifetime
  policy code change. A leak could retain broad project access for up to30days
  unless revoked server-side. This patch does not implement that option.

Validation uses synthetic credentials and an isolated HTTP login server only;
there was no real Infisical login, IAM change, grant read or migration.
