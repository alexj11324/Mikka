# Personal plugin backend

- **Status:** implemented backend; frontend follow-up is separate.
- **GitHub:** #581, #582, #583.
- **Scope:** Alex confirmed this delivery is backend only, in one PR.

People add personal MCP servers, install skills and connect supported apps for
their Bots. Installation and connection belong to the signed-in person across
workspaces. Neither a teammate nor a workspace admin receives another person's
connection or credential. This change does not redesign the plugin page.

## API contracts

All endpoints require the normal signed-in session and return private, no-store
responses. Mutations require the exact application Origin. Unknown owners cannot
be supplied in request bodies; all row operations include the authenticated owner.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/integrations/mcp` | — | `{servers, count}`; each row has id, name, URL, transport, enabled, revision, authKind and createdAt |
| `POST /api/integrations/mcp` | `{name,url,transport?:"http"\|"sse",enabled?:boolean,auth?:{name,value}}` | `{server}`; enabled defaults to true |
| `PATCH /api/integrations/mcp` | `{id,name?,enabled?,auth?:{name,value}\|null}` | `{server}`; null removes authentication |
| `DELETE /api/integrations/mcp` | `{id}` | `{deleted:true}` |
| `GET /api/skills` | — | `{skills,count,scope:"personal"}`; metadata includes source kind, source revision/path and SHA-256 |
| `POST /api/skills` | `{source:"owner/repository",slug:"skill-name"}` from a skills.sh search result | `{skill}`; repeated installation returns the existing pinned version |
| `PATCH /api/skills` | `{id,enabled}` | `{skill}` |
| `DELETE /api/skills` | `{id}` | `{deleted:true}` |
| `GET /api/integrations/composio/catalog` | — | `{configured,apps,popular,latest,categories}`; each app has id, name, one-line description, icon, Composio categories and created date; `popular`, `latest` and each category list app ids |
| `GET /api/integrations/composio/catalog/{toolkit}` | — | One app's page: `{id,name,description,iconUrl,categories,website,version,tools:{write,read}}` from Composio, cached an hour per app; needs a signed-in person, not a connected account |
| `POST /api/integrations/composio` | existing `{toolkit,returnTo?}` | Accepts any store toolkit (Composio-managed auth) through the existing Composio hosted connection flow |

MCP accepts public HTTPS hostnames on port 443. Credentials in URL userinfo or
query strings are refused. Authentication headers are Authorization, X-API-Key,
Api-Key or X-Auth-Token. An OAuth bearer access token can be saved as an
Authorization header; this delivery does not introduce an OAuth consent or token
refresh flow for arbitrary MCP servers. URLs are immutable: create a new
connection to move a server without forwarding an existing credential elsewhere.
Authentication values use the existing AES-GCM vault primitive and
`WORKSPACE_SECRETS_KEY`; associated data binds owner, server id, URL and header.
They are write-only in APIs and never enter execution snapshots. Missing vault
configuration refuses credential writes and authenticated calls.

Skills are Markdown guidance. The backend resolves the source repository HEAD
to a commit, selects one `SKILL.md` by its frontmatter name (which may differ
from its directory), and stores the exact body, path,
commit and hash. Truncated trees, ambiguous matches and oversized bodies fail.
It inspects at most 200 pinned Markdown files, six at a time within the source
deadline. No installer, repository hook, script or relative asset is executed or fetched.
Uninstall then install is an explicit way to adopt a newer source revision.
Source kinds reserve built-in and self-improvement provenance, but this endpoint
installs skills.sh sources only; it does not automatically promote experiment
candidates or change the existing improvement activation policy.

Operational bounds: 20 MCP servers and 20 installed skills per person; each
skill is at most 20 KB and total installed guidance at most 100 KB. Mutating
requests are bounded before parsing. Limits return a recoverable 409/413/422.

## Bot execution

New versioned executions freeze enabled skill bodies/hashes, MCP ids/revisions
and newly connected catalog capabilities separately from the saved Bot definition.
Existing executions replay their original snapshot. Personal installations can
add their two MCP discovery/call capabilities without rewriting custom Bot
definitions; a confirmed Google Drive connection similarly makes its supported
read available in new executions. Unversioned turns read the current personal
installations. Skills remain subordinate to platform and permission policy.

MCP tools are exposed through `list_personal_mcp_tools` and
`call_personal_mcp_tool`. Both use host-owned identity and execution context.
Current owner/enabled/revision are rechecked before remote dispatch. Removing,
disabling or replacing a credential stops subsequent calls; it cannot cancel a
request already sent. Server descriptions and results stay tool evidence. They
cannot become host instructions or grant access to Mikka tools. Scheduled reads
do not receive arbitrary MCP tool capabilities.

Remote requests pin public DNS addresses, preserve the configured HTTPS proxy,
original Host and TLS SNI, refuse redirects and cross-origin SSE endpoints,
and use bounded response streams/deadlines. A proxy must permit CONNECT to the
validated public address; refusal fails closed. Tool calls have no automatic
SDK or Workflow retries. Lost/invalid responses after dispatch return
`mcpOutcomeUnknown`, rather than claiming failure or retrying a possible effect.
Literal saved authentication values are masked from remote results.

## Store directory (decision 2026-10-31)

The 插件 store lists every Composio toolkit a person can connect with
Composio-managed auth, read from Composio v3 `GET /toolkits?sort_by=usage`
and cached for an hour per server (`lib/plugins/catalog.ts`). 现状（非决定）：toolkits
that need the person's own credentials (no managed auth), no-auth and local
toolkits are left out. Composio's copies of GitHub and Linear are left
out: Mikka's own GitHub, Linear and Telegram connections keep their native
paths. 热门 is the first twelve in Composio's usage order, 新品推荐 the twelve
with the newest `meta.created_at`, and categories are Composio's own; Mikka
ranks nothing itself.

Connections stay per person (R-35 decision 2026-10-31). A workspace admin can
turn any store app off for the workspace's Bots through the app-policy API.

Bots and the Coordinator reach a connected store app through two generic tools
(`lib/app-tools.ts`), not hand-written actions: `list_app_tools` lists the
toolkit's Composio tools (with `readOnly` from `readOnlyHint`), and
`call_app_tool` runs one, pinned to its version, in the person's own account.
Reads run at once. A write follows R-77: an explicit setting in the person's or
workspace's external-write settings, keyed by the lower-case tool slug or the
toolkit slug, wins (a workspace setting only narrows); otherwise the shared
write judge (`lib/operations/write-judgment.ts`: the Decisions API, given the
tool's MCP hints and the concrete arguments) decides. A call it judges
destructive becomes an approval card (`pending_actions.action =
'app_tool_call'`), and so does a call it cannot judge. Every other write runs directly and leaves a
`pending_actions` record; an unclear outcome stays `running` and is never
resent. The hand-written Gmail, Calendar, Notion, Slack and Drive tools are
unchanged.

## Validation

- `pnpm test:plugins`: actual route contracts with controlled auth/store seams;
  real MCP SDK over local HTTP/SSE servers, unknown outcomes, masking, URL/DNS
  restrictions, pinned skill retrieval and provider catalog/action contracts.
- `pnpm test:plugins-db`: real isolated PostgreSQL; idempotent migration,
  owner/peer separation, encrypted authentication, enable/rename/delete,
  skill install/toggle/uninstall and immutable execution replay.
- Existing integrations, Agent Kit compatibility, source checks, migrations and
  required PR CI/browser gates remain in force.

Provider connection acceptance is distinct from controlled fixtures. This
delivery does not claim a new real Google OAuth connection or a public MCP
provider account was exercised by the local protocol fixtures.
