# Default BYOS worker build and packaging

Previously Next tracing included binaries only if another step had already built
them. Prior local artifact checks did not prove a clean default Vercel build.

Default `pnpm build` now first runs `build:byos-workers`. On Linux x64 this downloads
official Go1.26.10, verifies its pinned SHA256, verifies the pinned CPA checkout,
and compiles both production commands with CGO disabled and trimmed paths. The
compiler/bootstrap environment excludes application/vault credentials. Compilation
or integrity failure stops the app build. No pre-generated binary is trusted.

After Next build, the artifact checker reads all eight route tracing manifests,
requires the appropriate executable Linux x64 binary, rejects upstream source,
compiler cache and fixture payloads, and launches each copied binary from an
isolated artifact root using `--version` with no credentials/network calls.

Production runtime variables must use these packaged relative paths:
- MIKKA_BYOS_WORKER_BINARY=packages/subscription-worker/bin/mikka-subscription-worker
- MIKKA_BYOS_ENROLLMENT_BINARY=packages/subscription-worker/bin/mikka-subscription-enrollment

Vercel must use the default package build (or explicitly invoke the same worker
build and verifier). Overriding buildCommand with bare `next build` bypasses the
package pipeline and is not supported. The release owner must verify the configured
buildCommand. Source code alone does not prove a deployed Vercel function starts.
Actual deployment and provider acceptance remain separate and were not performed.
