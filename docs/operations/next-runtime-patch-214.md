# Next runtime dependency patch (#214)

Source baseline: `375d670937ca06c53e47f336870481d38520c1fe`.
The root application directly declares Next `16.1.6`. The registry audit on
2026-10-31 reports applicable version ranges for multiple Server Actions,
App Router denial-of-service and proxy-bypass advisories. The application
uses these surfaces. This is evidence to patch the dependency, not proof
that an exploit succeeded against Mikka.

The minimum same-major patched version covering the current advisory ranges
is `16.4.1`. The official npm registry confirms that version, its tarball
integrity, Node `>=20.9.0` and React `^19.0.0` peer support. The selected cloud
runtime is Node 24; the existing lock selects React 19.3.1. These are declared
compatibility checks, not build or runtime acceptance.

Relevant advisory references include:

- [Server Actions DoS](https://github.com/advisories/GHSA-p3m5-59mp-jv5r): patched in 16.4.1.
- [App Router proxy bypass](https://github.com/advisories/GHSA-26hh-7cqf-hhc6): patched in 16.2.6 and covered by the selected update.
- [Server Components DoS](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3): patched in 16.2.3 and covered by the selected update.

The registry's critical totals must not be presented as reproduced Mikka
vulnerabilities: this application sets `images.unoptimized=true`, no `use cache`
directive was found, and the tested runtime is Linux. Image-optimizer/cache
and Windows-specific critical conditions are not established here.

## Resolution boundary

Only the root Next declaration changes. Resolution ran in a new temporary
manifest-only directory without `node_modules`; it could not update the
parent's installed packages. All unrelated direct resolutions were held at
their existing versions during resolution, then their original manifest
specifiers were restored. A frozen-lockfile-only validation confirms that
the resulting lock matches all six workspace manifests. The sole changed
specifier is root Next `16.1.6` → `16.4.1`.

The changed package records are the Next platform packages, its SWC helpers
and PostCSS; obsolete Sharp records no longer selected by Next are removed.
Unrelated shadcn, Lucide, TypeScript and application dependency resolutions
are retained. No install hooks ran and no parent dependency was replaced.

Retained private local evidence:

- `/tmp/mikka-old-ops-next-registry.json`
- `/tmp/mikka-old-ops-audit.json`
- `/tmp/mikka-ops-next-minimal.log`
- `/tmp/mikka-ops-next-frozen-proof.log`
- `/tmp/mikka-ops-next-patched-audit.json`

The patched lock audit no longer reports Next, Sharp or PostCSS advisories.
Other workspace advisories remain and need artifact-specific reachability
triage; there is no blanket exemption or claim that the entire dependency
graph is clean. In particular optional test peers and Expo CLI dependencies
must not automatically be counted as shipped server code.

Installation, application/package types, the production build and affected
runtime/browser acceptance run on the parent's frozen integration version
or actual CI after this patch is integrated. They have not been run against
newly installed dependencies in this child worktree.
