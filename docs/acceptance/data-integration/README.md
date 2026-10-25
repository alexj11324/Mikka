# Actor and server search integration

Independent stack on reviewed PR285 `95d779be2ef4159ad9b2445b90f29591ca4ecefb`.
Source #168 `5aec7c49d10856e8773ba214dfc85977d7b1fb99` and #170
`1c3e733c18f9521775ab89245d01f7beece1b692` include newer main design docs,
CLA removal and the authors' reordered migrations. Source branches remain unchanged.
R alone coordinates main integration. No frontend picker/layout or archive/unlink work.

The worker actor join adds agentId to the existing executor query; run kind,
current authority checks, double-database transactions and revocation remain intact.
Server actor context never comes from client actor fields. Search uses existing
metadata visibility, not execution authority. The PR285 owner-only Agent assignment
capability remains unchanged. No external Linear writes are added.

The dedicated workflow executes retained fixtures against separate application and
workspace PG17 databases, actor migration replay, actual action writers (framework
session/background dispatch isolated), search/index tests over 12,000 synthetic tasks,
types, lint/build, daemon regressions and actual Next HTTP. The HTTP data script
verifies caller attribution despite forged fields, history denial, 125-row pagination
with microsecond timestamps, escaped wildcard/injection text, bounded parameters,
hidden anchors, foreign workspace and revoked membership. MCP HTTP checks verified
OAuth client attribution. Worker core checks verified agentId and current revocation.
No cookies, tokens, raw RSC or real user data enter the evidence artifacts.

Fixtures are retained; no DELETE cleanup or schema drop. The member-removal writer
is not executed in this retained-record acceptance. Existing Telegram /confirm emits
backlog, while the baseline SQL status check rejects backlog. This candidate leaves
that unrelated status contract unchanged and explicitly checks rollback; it does not
claim Telegram creation acceptance. No production performance guarantee follows
from the maintained synthetic trigram EXPLAIN result.

New migrations: 20261025200000 actor columns/checks, then 20261025200100–200400
search extension/indexes. Apply through the existing serial migration runner before
new code. Concurrent index files remain outside transactions. No production migration,
merge, deployment, real-user/UI acceptance or redacted production video performed here.

Integrated-schema regression: pg_trgm extension objects are explicitly installed
in public and the title index references public.gin_trgm_ops. Two retained schemas
with public excluded from search_path each build valid indexes. Production preflight
must confirm any pre-existing pg_trgm uses public; this candidate does not relocate
an existing extension or change production schema configuration.
