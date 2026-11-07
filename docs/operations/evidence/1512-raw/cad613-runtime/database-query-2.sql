WITH target AS (
 SELECT id, error FROM agent_runs WHERE id='f879d6cd-bdbd-4e62-9a17-441f1f763a25'::uuid
 AND "issueId"='43486283-4731-4842-bce1-fa5f1e96b8f9'::uuid
 AND "deviceId"='09479c68-dcb4-4735-a91f-e355259c0eef'::uuid
), patterns(code,pattern) AS (VALUES
 ('reasoning','reasoning|effort'),('config','config|setting|parameter|argument|value'),
 ('invalid','invalid|unexpected|unknown'),('support','not support|unsupported'),
 ('model','model'),('message','message|instruction|prompt'),('request','request|response'),
 ('process','exit|spawn|process|launch|binary'),('payload','json|parse|serializ|deserializ|decode|encode'),
 ('mcp','mcp|tool|approval'),('identity','credential|grant|lease|identity|token|auth'),
 ('file','file|directory|path'),('cloud','cloud|sandbox|bootstrap'),
 ('plan','plan|tier|access'),('server','server|internal|error')
)
SELECT jsonb_build_object(
 'runId',t.id,
 'errorAsciiOnly',t.error !~ '[^ -~]',
 'errorPatternMatches',COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM patterns WHERE t.error ~* pattern),'[]'::jsonb),
 'stages',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'seq',c.seq,'at',c."createdAt",
   'stage',CASE WHEN c.chunk->'data'->>'stage' IN ('repository','worktree','agent_start') THEN c.chunk->'data'->>'stage' ELSE 'unknown' END,
   'ok',CASE WHEN jsonb_typeof(c.chunk->'data'->'ok')='boolean' THEN c.chunk->'data'->'ok' ELSE 'null'::jsonb END,
   'ms',CASE WHEN jsonb_typeof(c.chunk->'data'->'ms')='number' THEN c.chunk->'data'->'ms' ELSE 'null'::jsonb END
 ) ORDER BY c.seq),'[]'::jsonb) FROM run_chunks c WHERE c."runId"=t.id AND c.chunk->>'type'='data-run-stage'),
 'finish',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'seq',c.seq,'at',c."createdAt",
   'runtimePresent',c.chunk->'messageMetadata' ? 'mikkaRuntimeTiming',
   'runtimeComplete',c.chunk->'messageMetadata'->'mikkaRuntimeTiming'->'complete'='true'::jsonb,
   'runtimeTruncated',c.chunk->'messageMetadata'->'mikkaRuntimeTiming'->'truncated'='true'::jsonb,
   'actualCodexAck',c.chunk->'messageMetadata'->'mikkaRuntimeTiming'->'agentAccepted'->>'kind'='codex_turn_start_ack',
   'finishReason',CASE WHEN c.chunk->>'finishReason' IN ('stop','length','content-filter','tool-calls','error','other','unknown') THEN c.chunk->>'finishReason' ELSE 'unknown' END
 ) ORDER BY c.seq),'[]'::jsonb) FROM run_chunks c WHERE c."runId"=t.id AND c.chunk->>'type'='finish')
) AS diagnostic FROM target t;
