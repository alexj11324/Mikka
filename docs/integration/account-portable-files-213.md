# Portable account files (#213)

Base: `e5261087`, cloud Linux. The existing JSON download selected artifact
summaries but no artifact bodies, captures or recovery patches. A normal account
export therefore could not reconstruct the person's own documents or evidence.
Occurrence 8 × impact 7 = 56: ordinary authored files were missing from every
such export despite the existing "everything" description.

The same account export download now appends `files` and `fileManifest` to its
existing JSON format and filename. It includes every owned artifact version,
owned capture and masked source checkpoint. Each available file has base64
bytes, type, name, byte count and SHA-256; checkpoint bytes remain the existing
gzip patch. It does not select native authentication/session caches or
platform credential records. User-authored file contents remain unchanged.
Storage keys and provider credentials are not in the exported metadata.

Metadata is enumerated first, then only one inline file or R2 object is opened
at a time. R2 recordings stream through the existing authenticated storage
adapter; base64 encoding carries incomplete byte triples between chunks. The
byte count and digest must match before that file can finish. A missing object,
changed file, changed owner, expired/revoked authority or request cancellation
aborts the body rather than publishing valid partial JSON as a complete export.
A recording not yet ready or an oversized/unavailable checkpoint is represented
explicitly with null content and an unavailable reason; `fileManifest.complete`
is false. These are never disguised as successful empty files.

The route uses a real browser identity, bypassing session cookie caching and
refresh. A workspace-scoped API token alone cannot combine with an export link
to read account-wide data. The existing owner-bound 24-hour grant is checked
again before each file, after it, and at one-MiB streaming boundaries alongside
current ownership. No expiry is extended. Consumer cancellation aborts the
upstream object request; no completion manifest is emitted afterward.

## Verification and limits

- Actual existing isolated PostgreSQL 17 at
  `127.0.0.1:55599/mikka_audit_closeout_e2e`, no new database/container.
- `lib/account/export-files.db.test.ts`: 7/7, no skips. It exercises the real
  ownership queries, metadata export, byte/base64/versions/hash readback,
  other-owner descriptor denial before object access, missing/corrupt data,
  changed ownership, streaming revocation/cancellation and explicit unavailable
  states. R2 IO is an explicit adapter substitute backed by a real loopback HTTP
  object fixture; this is not Cloudflare R2 or deployed-app acceptance.
- `pnpm test:account`: 5 source tests plus 22 account/route tests pass, including
  three new route-boundary cases. Browser/session IO is explicit fixture IO,
  not a claim that OAuth or a real login was repeated.
- Logs: `/tmp/mikka-remaining-export-files-db-final.log` and
  `/tmp/mikka-remaining-export-account-source-final.log`. Typecheck, targeted
  lint and required-DB runner source checks pass.

This supplies the missing portable file bytes without a new export platform,
bucket, queue or secret. #213 still requires the broader fixed-application
asset/deletion/restore acceptance and explicit external retention/backup policy;
this component alone does not establish those or justify closing the whole issue.
