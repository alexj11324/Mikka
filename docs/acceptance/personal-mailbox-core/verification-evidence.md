# Verifiable synthetic mailbox acceptance evidence

`r4-verification.mts` is an offline evidence writer/checker. It imports only
Node built-ins. It does not connect to a database, create credentials, authorize
tools, start services, or add runtime capabilities. Run its pure suite with
`node --import tsx --test scripts/personal-mailbox-acceptance/r4-verification.test.mts`.

The fixed scope matches the retained R3 synthetic schema: all14 protected tables
(including empty tables) and48 ACL identities (role,14 table ACLs,32 column ACLs,
one relation filenode). Scope is frozen in code and checked against the actual
schema source by the separate runner integration test. Missing/duplicate scope
cannot establish a valid baseline or pass by matching two incomplete results.

The writer stores projected SQL results in a new private `verification.jsonl`:

- Actual rowCount, requested IDs and returned token/run bindings for INSERT and
  revocation, plus the final readback set. Empty/missing/duplicate tokens fail.
- Original, refreshed and restored lease text with six UTC fractional digits,
  its SHA256, UPDATE row counts and returned values. JS Date validates format;
  it never serializes the authoritative PG timestamp.
- All protected table counts/digests and per-identity ACL descriptor hashes,
  baseline/final aggregate hashes and recomputed comparison checks. Raw rows,
  ACL descriptors, token hashes, bearer values and passwords are not copied.
- Query failure operation/SQLSTATE only. Arbitrary error/config/SQL bodies and
  extra runtime metadata fields are excluded.

Writes are exclusive, append-only and require an owned0700 directory/0600 regular
file with unchanged inode. Missing/partial/modified bytes or footer fail the
independent file check. `finish()` reads persisted bytes and checks them before
returning a result; it does not approve from its in-memory summary alone.

For later file-only verification, pass `verifyEvidence(records, bindings,
{sourceSHA, manifestSHA, roundId, lastSHA})`. These expected values must come from
the separately pinned manifest and receipt, not be inferred from the file under
review. The receipt includes final chain anchor and whole-file SHA256. A hash
chain is an integrity/consistency check, not an execution signature or proof of
provider identity. Source attribution and permission still come from the host.

The runner integration adds safe RETURNING/readback fields and requires complete
baseline evidence before mutations. Logging failures cannot skip token revoke,
lease restore or resource shutdown. It does not add write targets or DDL/ACL.
Any changed SQL/hash/profile still needs a newly frozen, separately approved
real run. This component is independently deliverable before that integration.

The earlier real R4 nonce0002 passed its four limited checks on source0f9492d1.
Both cancel control connections timed out locally before discard; real PG57014
and observed backend state established the2500ms proof. Its final verification
SQL rows were not fully persisted. This new component does not reconstruct or
retroactively claim those historical returns. Its pure tests are synthetic data,
not another PG run, positive TLS, real provider or production acceptance.
