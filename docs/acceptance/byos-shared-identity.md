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

## Issuer token lifetime

The application accepts the issuer's valid lifetime, including the existing
2592000-second (30-day) token, without an additional opt-in or one-hour ceiling.
It still validates Bearer response shape, safe finite expiry arithmetic, elapsed
request time and sufficient remaining validity for the worker lease. HTTPS origin,
redirect refusal, credential rotation, denial fencing and separate caches remain.

A token remains valid at Infisical until its actual expiry or server revocation.
Early refresh, local cache eviction and local rejection do not revoke old tokens.
In particular, refreshing does not make the previous30-day admin bearer short-lived.
No Infisical TTL configuration, IAM privilege or production cleaner setting is
changed. Official login documents no per-request TTL override:
https://infisical.com/docs/api-reference/endpoints/universal-auth/login

The shared Universal Auth helper is also used by the credential cleanup broker.
It now accepts valid issuer lifetimes above one hour too, including in its default
minimumValidityMs=0 mode. Its separate identity, configured paths, delete policy,
401/403 invalidation and no-static-fallback behavior remain unchanged. The same
long-lived bearer exposure applies if that issuer returns a long token.

Validation uses synthetic credentials and isolated HTTP login servers only;
there was no real Infisical login, IAM change, grant read or migration.
