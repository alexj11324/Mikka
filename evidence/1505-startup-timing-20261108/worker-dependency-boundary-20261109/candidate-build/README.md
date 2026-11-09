# Exact e73 canonical worker build

The parent committed the reviewed five files as e73f12c072786786883ba932689fc00cc8e2ea71, tree a1c4bfbc53e08307e9f3461c18c31a5f58131048. This addendum uses that exact checkout and the original build-template.py worker-hash command. The canonical worker fingerprint is cd10b53c37242736be3bb91b841f2220772a1681.

Before linking dependencies, all six source package/lock/workspace files were compared byte-for-byte with the source of the successful actual-A private installation. The three installed package manifests were also compared with e73. Dependencies are reused from that successful frozen install; no new install was performed. Relative node_modules links point at the preserved owned install directory. That dependency installation and stage relocation evidence remains in the earlier frozen directory.

The exact e73 build-cloud-worker.mjs command completed successfully. Verification retains the existing checks for two bundles, nine resources, sixteen fixtures, twelve syntax checks, and immutable broker/capability modes. SDK, pino and esbuild resolve inside the verified dependency closure. The original A-marker outputs remain untouched and are not relabelled as the new worker.

This is local build/resource verification with Node24.22.1, while the official template pins Node24.19.0. It does not represent a new E2B template build, official-CLI checksum/conservation run, native subscription acceptance, deployed runtime or formal six-case result. Historical failures stay failures. No production action or Git ref mutation was performed by this agent.
