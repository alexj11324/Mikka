# Released protocol fixtures

This archive preserves exact public source bytes from successful serving
releases. Its files are historical evidence, not current application build
inputs. Contract tests verify their Git blob identities, copy them into a
temporary directory and execute the old caller against the current service.

- [Eve caller from `64a3a8df`](released-64a3a8df/README.md) covers run creation,
  startup and full/metadata-only reads through the World Worker.

The [hosted API compatibility decision](../design/decisions/2026-11-20-1300-hosted-api-compatibility.md)
owns the compatibility and retirement rules. Updating a fixture requires a
successful serving receipt; changing archived source to pass a test would
invalidate that evidence.
