# API route registration probe

`scripts/ops/route-probe.mjs` checks every entry in
`apps/api/generated/routes.json` through the deployed HTTP dispatch path. It is
anonymous and does not invoke application handlers, write business data, or
call a model. The existing authenticated feature smoke remains a separate gate.

```sh
ROUTE_PROBE_BASE_URL=http://127.0.0.1:3000 node scripts/ops/route-probe.mjs
```

The target is required. HTTPS is accepted; plain HTTP is allowed only on
loopback. `ROUTE_PROBE_MANIFEST` can select a different inventory file. A release
must use the inventory from its **API artifact's source commit**, which can be
older than the overall release commit when that service is reused.

For a route without an explicit OPTIONS handler, the API dispatcher returns
204 and its `Allow` header before loading any handler. A route with an OPTIONS
handler is probed with another undeclared method and must return 405 with the
same complete `Allow` contract. Dynamic path segments use inert placeholders.
A route implementing every supported method fails configuration rather than
silently executing a handler. Redirects are not followed. A 404, any 5xx, a
missing method, or a generic OPTIONS response without the expected `Allow`
header fails the gate.

The report at `production-smoke-report/route-probe.json` records route patterns,
methods, status codes and closed failure codes. It does not retain target
origins, credentials, response bodies or dynamic user identifiers. Requests
have no cookies, authorization or body, use at most eight concurrent requests,
and have a 15-second deadline each.

`apps/api/src/route-probe.test.ts` starts the real API dispatcher on a loopback
HTTP server with the generated inventory. It verifies every registered route,
then removes one route and requires a real 404 failure. Handler loaders fail
the test if invoked. This proves registration and method dispatch; it does not
claim authentication, database reads or business-handler coverage. Those are
covered by the existing API tests and `production-smoke.mjs`.

Company deployment orchestration, environment selection, credentials and
rollback records remain in the private operations repository. The public probe
also accepts a `fetchImpl` so that deployment tooling can use an existing remote
Service Binding without creating a public staging endpoint.
