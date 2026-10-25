# Audit #210 validation history

Source branch: codex/enterprise-audit-210. Production main was not changed.

- Initial development fixture reused a fixed synthetic session token; repeat run collided with its unique constraint. Fixed to generate a fresh synthetic token. No real session or grant was used.
- Initial build under the restricted host failed SWC native cache trust validation. Build moved to a standard ephemeral Node 24 Docker environment, mounting only the project and the environment CA certificate. The proxy CA was explicitly trusted; TLS validation was not disabled.
- Initial Docker build lacked CI loopback-origin configuration; corrected with CI=true and explicit synthetic local URLs. A later successful intermediate build lacked a database connection and emitted a Better Auth schema-validation warning. Final build uses the explicit separate disposable databases.
- First remote mailbox regression failed because its intentional legacy-schema fixture installed the new audit consumer before its mailbox dependency. The fixture now installs audit after the mailbox migration; 29/29 local checks and the subsequent remote mailbox jobs passed. The production audit dependency remains fail closed.
- Additional operator attribution assertion was initially placed before its event existed. The corrected assertion runs after pruning and verifies a system actor. This was a test ordering error; the final suite is authoritative.
- Broad pnpm check remains stopped by 3 baseline Agent frontend/static-regex assertions in unchanged source/tests (hydration import location, title-menu Popover, first tool ordering). Not claimed as green; no UI implementation/test assertions were changed to hide them.

Final evidence covers synthetic isolated cloud Linux behavior. It does not establish deployed Preview, real Google/GitHub/provider/daemon/CLI or production user acceptance. Database-owner whole-chain rewrite is outside this local hash-chain threat model. The issue remains open.
- Actual production-built Next HTTP exposed a legitimate audit POST being rejected because Next's internal request URL had a different origin. The runtime now uses the configured application origin; a proxy-URL regression still rejects a foreign/internal origin. This was a real integration finding, not an assumed pass. Final source is 9532817f3456ae0ed4decc9cd5d7e0e5bac95feb.
- Event retention applies to event payloads. Expired export manifests, hash-only dedupe keys and resource-scope metadata keep non-secret identifiers; complete metadata erasure is a separate governance decision.
