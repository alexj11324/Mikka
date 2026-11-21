# Released protocol fixtures

This archive preserves exact public source bytes from successful serving
releases. Its files are historical evidence, not current application build
inputs. Each archived module has a `.txt` suffix; `release.json` retains its
original source path and Git blob identity. Contract tests verify those exact
bytes, restore the original paths in a temporary directory and execute the old
caller against the current service. Current-source lint rules remain unchanged.

- [Eve caller from `64a3a8df`](released-64a3a8df/README.md) covers run creation,
  startup and full/metadata-only reads through the World Worker.

The [hosted API compatibility decision](../design/decisions/2026-11-20-1300-hosted-api-compatibility.md)
owns the compatibility and retirement rules. Updating a fixture requires a
successful serving receipt; changing archived source to pass a test would
invalidate that evidence.
