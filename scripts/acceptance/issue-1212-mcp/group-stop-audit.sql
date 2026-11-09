-- #1212 (adapted from the frozen #1506 audit): one statement, one snapshot, no mutations/locks/polling.
-- Run only after observing group_turn_terminal for this exact group/message.
-- Parameters: $1 authenticated shared-smoke owner, $2 selected team UUID, $3 owned group UUID,
-- $4 owned root message UUID, $5 exact generated title, $6 the two owned Bot UUIDs.
-- The runner verifies the normal shared session and exact fixture before this one read.
WITH input AS (
  SELECT $1::text AS owner_id, $2::uuid AS workspace_id,
    $3::uuid AS group_id, $4::uuid AS message_id, $5::text AS group_title,
    $6::uuid[] AS bot_ids
  WHERE length($1::text)>0 AND cardinality($6::uuid[])=2
    AND ($6::uuid[])[1] IS DISTINCT FROM ($6::uuid[])[2]
    AND current_database()='orvilo_mvp' AND current_schema()='public'
), scope AS MATERIALIZED (
  SELECT i.*, m.position AS root_position, m."createdAt" AS root_created_at,
    c."lastPosition" AS last_position, c."leadBotId" AS lead_bot_id,
    t.status, t.error, t.trace, t."activeRunId" AS active_run_id,
    t."agentId" AS agent_id, t."botId" AS active_bot_id,
    t."createdAt" AS turn_created_at, t."updatedAt" AS turn_updated_at,
    t."decisionAttempts" AS decision_attempts, t."nextDecisionAt" AS next_decision_at
  FROM input i
  JOIN conversations c ON c.id=i.group_id AND c.kind='group'
    AND c."workspaceId"=i.workspace_id AND c."createdBy"=i.owner_id AND c.title=i.group_title
  JOIN conversation_messages m ON m.id=i.message_id AND m."conversationId"=c.id
    AND m."authorType"='user' AND m."authorId"=i.owner_id
  JOIN group_turns t ON t."messageId"=m.id AND t."conversationId"=c.id AND t."userId"=i.owner_id
  WHERE (SELECT count(*) FROM bots b WHERE b.id=ANY(i.bot_ids)
    AND b."ownerId"=i.owner_id AND b."workspaceId"=i.workspace_id)=2
), membership AS (
  SELECT count(*) AS total,
    count(*) FILTER (WHERE cm."leftAt" IS NULL) AS active,
    count(*) FILTER (WHERE cm."memberType"='user' AND cm."memberId"=s.owner_id
      AND cm.role='owner' AND cm."leftAt" IS NULL) AS active_expected_owner,
    count(*) FILTER (WHERE cm."memberType"='bot' AND cm.role='member' AND cm."memberId"=ANY(s.bot_ids::text[])
      AND cm."leftAt" IS NULL) AS active_expected_bots,
    count(*) FILTER (WHERE NOT (cm."memberType"='user' AND cm."memberId"=s.owner_id
      OR cm."memberType"='bot' AND cm."memberId"=ANY(s.bot_ids::text[]))) AS unexpected_members,
    count(*) FILTER (WHERE cm."leftAt" IS NOT NULL) AS departed
  FROM scope s JOIN conversation_members cm ON cm."conversationId"=s.group_id
), public_rows AS MATERIALIZED (
  SELECT m.id,m.position,m."createdAt" AS created_at,
    CASE WHEN m."authorType"='bot' AND m."authorId"=s.bot_ids[1]::text THEN 'lead'
      WHEN m."authorType"='bot' AND m."authorId"=s.bot_ids[2]::text THEN 'peer' ELSE 'unexpected' END AS author_fixture
  FROM scope s JOIN conversation_messages m ON m."conversationId"=s.group_id AND m."replyToId"=s.message_id
), links AS MATERIALIZED (
  SELECT l.id,l."linkedConversationId" AS private_id,l."firstPosition" AS first_position,
    l."lastPosition" AS last_position,l."messageCount" AS declared_count,
    (dm.id IS NOT NULL AND dm.kind='agent_dm' AND dm."workspaceId"=s.workspace_id
      AND dm."createdBy"=s.owner_id) AS owned_private_scope,
    s.bot_ids
  FROM scope s JOIN conversation_links l ON l."sourceConversationId"=s.group_id AND l."anchorPosition"=s.root_position
  LEFT JOIN conversations dm ON dm.id=l."linkedConversationId"
), private_membership AS (
  SELECT l.id,
    count(cm."memberId") FILTER (WHERE cm."leftAt" IS NULL) AS active,
    count(cm."memberId") FILTER (WHERE cm."leftAt" IS NULL AND cm."memberType"='bot' AND cm.role='member'
      AND cm."memberId"=ANY(l.bot_ids::text[])) AS active_expected_bots,
    count(*) FILTER (WHERE cm."leftAt" IS NOT NULL) AS departed
  FROM links l LEFT JOIN conversation_members cm ON l.owned_private_scope AND cm."conversationId"=l.private_id
  GROUP BY l.id
), private_rows AS MATERIALIZED (
  SELECT l.id AS link_id,m.id,m.position,m."createdAt" AS created_at,
    CASE WHEN m."authorType"='bot' AND m."authorId"=l.bot_ids[1]::text THEN 'lead'
      WHEN m."authorType"='bot' AND m."authorId"=l.bot_ids[2]::text THEN 'peer' ELSE 'unexpected' END AS author_fixture
  FROM links l JOIN conversation_messages m ON l.owned_private_scope AND m."conversationId"=l.private_id
    AND m.position BETWEEN l.first_position AND l.last_position
), trace_events AS MATERIALIZED (
  SELECT ord,
    CASE WHEN event->>'type' IN ('wake','generate','silent','publish','private_publish','delegate','task_result')
      THEN event->>'type' ELSE 'unknown' END AS type,
    CASE WHEN event->>'memberId'=s.bot_ids[1]::text THEN 'lead'
      WHEN event->>'memberId'=s.bot_ids[2]::text THEN 'peer'
      WHEN event->>'memberId' IS NULL THEN NULL ELSE 'unexpected' END AS member_fixture,
    CASE WHEN event->>'outcome' IN ('started','succeeded','blocked','failed','stopped') THEN event->>'outcome'
      WHEN event->>'outcome' IS NULL THEN NULL ELSE 'unknown' END AS outcome,
    event ? 'taskId' AS has_task_id, event ? 'runId' AS has_run_id
  FROM scope s CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.trace->'events')='array' THEN s.trace->'events' ELSE '[]'::jsonb END)
    WITH ORDINALITY x(event,ord)
), task_bindings AS MATERIALIZED (
  SELECT b."issueId" AS issue_id,b."createdAt" AS created_at,
    b."userId"=s.owner_id AND b."reporterOwnerId"=s.owner_id AS owned,
    b."reporterType"='bot' AND b."reporterId"=ANY(s.bot_ids) AS expected_reporter,
    b."executionBotId"=ANY(s.bot_ids) AS expected_execution_bot
  FROM scope s JOIN group_task_bindings b ON b."conversationId"=s.group_id AND b."sourceMessageId"=s.message_id
), task_receipts AS MATERIALIZED (
  SELECT r."issueId" AS issue_id,r."createdAt" AS created_at,r."userId"=s.owner_id AS owned,
    r."reporterId"=ANY(s.bot_ids) AS expected_reporter,
    CASE WHEN r.operation IN ('create','continue','status','stop') THEN r.operation ELSE 'unknown' END AS operation
  FROM scope s JOIN group_task_receipts r ON r."conversationId"=s.group_id AND r."messageId"=s.message_id
), lock_target AS (
  SELECT hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || s.group_id::text,0) AS key
  FROM scope s
), worker_locks AS MATERIALIZED (
  SELECT l.pid,l.granted,l.mode,
    a.pid IS NOT NULL AND a.state IS NOT NULL AS activity_visible,
    a.application_name='mikka-group-turn' AS group_worker,
    CASE WHEN a.state IN ('active','idle','idle in transaction','idle in transaction (aborted)','disabled','fastpath function call')
      THEN a.state WHEN a.state IS NULL THEN NULL ELSE 'unknown' END AS state,
    CASE WHEN a.wait_event_type IN ('Activity','BufferPin','Client','Extension','IO','IPC','Lock','LWLock','Timeout')
      THEN a.wait_event_type WHEN a.wait_event_type IS NULL THEN NULL ELSE 'unknown' END AS wait_event_type,
    a.backend_start,a.state_change
  FROM lock_target target JOIN pg_locks l ON l.locktype='advisory'
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND l.classid::bigint=((target.key >> 32) & 4294967295::bigint)
    AND l.objid::bigint=(target.key & 4294967295::bigint) AND l.objsubid=1
  LEFT JOIN pg_stat_activity a ON a.pid=l.pid
)
SELECT jsonb_build_object(
  'schemaVersion',1,'issue',1212,'observedAt',clock_timestamp(),
  'scopeMatched',EXISTS(SELECT 1 FROM scope),
  'scope',(SELECT jsonb_build_object('groupId',s.group_id,'messageId',s.message_id,
    'workspaceId',s.workspace_id,'ownerMatches',true,'rootPosition',s.root_position::text,
    'rootCreatedAt',s.root_created_at,'lastPosition',s.last_position::text,
    'leadIsFixture',s.lead_bot_id=ANY(s.bot_ids)) FROM scope s),
  'membership',(SELECT jsonb_build_object('total',m.total,'active',m.active,'activeExpectedOwner',m.active_expected_owner,
    'activeExpectedBots',m.active_expected_bots,'unexpectedMembers',m.unexpected_members,'departed',m.departed,
    'intact',m.total=3 AND m.active=3 AND m.active_expected_owner=1 AND m.active_expected_bots=2
      AND m.unexpected_members=0 AND m.departed=0) FROM membership m),
  'turn',(SELECT jsonb_build_object('status',s.status,'isStopped',s.error='stopped',
    'hasOtherError',s.error IS NOT NULL AND s.error<>'stopped','agentActive',s.agent_id IS NOT NULL,
    'botActive',s.active_bot_id IS NOT NULL,'activeRunId',s.active_run_id,
    'createdAt',s.turn_created_at,'updatedAt',s.turn_updated_at,
    'decisionAttempts',s.decision_attempts,'nextDecisionAt',s.next_decision_at,
    'traceStatus',CASE WHEN s.trace->>'status' IN ('pending','complete','blocked','failed','stopped')
      THEN s.trace->>'status' ELSE 'unknown' END,
    'traceFinishedAt',CASE WHEN s.trace->>'finishedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]{8,24}(Z|[+-][0-9:]{2,6})?$'
      THEN s.trace->>'finishedAt' ELSE NULL END,
    'traceEventsArray',jsonb_typeof(s.trace->'events')='array') FROM scope s),
  'public',jsonb_build_object(
    'totalGroupMessages',(SELECT count(*) FROM scope s JOIN conversation_messages m ON m."conversationId"=s.group_id),
    'otherUserRoots',(SELECT count(*) FROM scope s JOIN conversation_messages m ON m."conversationId"=s.group_id
      AND m."authorType"='user' AND m.id<>s.message_id),
    'replyCount',(SELECT count(*) FROM public_rows),
    'unexpectedAuthors',(SELECT count(*) FROM public_rows WHERE author_fixture='unexpected'),
    'rowsTruncated',(SELECT count(*)>50 FROM public_rows),
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'position',position::text,'createdAt',created_at,
      'authorFixture',author_fixture) ORDER BY position) FROM (SELECT * FROM public_rows ORDER BY position LIMIT 50) x),'[]'::jsonb)),
  'private',jsonb_build_object('linkCount',(SELECT count(*) FROM links),
    'otherAnchorLinks',(SELECT count(*) FROM scope s JOIN conversation_links l ON l."sourceConversationId"=s.group_id AND l."anchorPosition"<>s.root_position),
    'foreignScopeLinks',(SELECT count(*) FROM links WHERE NOT owned_private_scope),
    'invalidMemberships',(SELECT count(*) FROM private_membership WHERE active<>2 OR active_expected_bots<>2 OR departed<>0),
    'declaredMessages',COALESCE((SELECT sum(declared_count) FROM links),0),
    'actualMessages',(SELECT count(*) FROM private_rows),
    'unexpectedAuthors',(SELECT count(*) FROM private_rows WHERE author_fixture='unexpected'),
    'linksTruncated',(SELECT count(*)>20 FROM links),'rowsTruncated',(SELECT count(*)>50 FROM private_rows),
    'links',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'privateConversationId',CASE WHEN owned_private_scope THEN private_id ELSE NULL END,
      'ownedScope',owned_private_scope,'firstPosition',first_position::text,'lastPosition',last_position::text,'messageCount',declared_count)
      ORDER BY id) FROM (SELECT * FROM links ORDER BY id LIMIT 20) x),'[]'::jsonb),
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('linkId',link_id,'id',id,'position',position::text,'createdAt',created_at,
      'authorFixture',author_fixture) ORDER BY link_id,position) FROM (SELECT * FROM private_rows ORDER BY link_id,position LIMIT 50) x),'[]'::jsonb)),
  'trace',jsonb_build_object('eventCount',(SELECT count(*) FROM trace_events),
    'generateCount',(SELECT count(*) FROM trace_events WHERE type='generate'),
    'publicPublishCount',(SELECT count(*) FROM trace_events WHERE type='publish'),
    'privatePublishCount',(SELECT count(*) FROM trace_events WHERE type='private_publish'),
    'delegateCount',(SELECT count(*) FROM trace_events WHERE type='delegate'),
    'taskEventCount',(SELECT count(*) FROM trace_events WHERE type IN ('delegate','task_result') OR has_task_id OR has_run_id),
    'unknownEvents',(SELECT count(*) FROM trace_events WHERE type='unknown' OR member_fixture='unexpected'),
    'eventsTruncated',(SELECT count(*)>100 FROM trace_events),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('ordinal',ord,'type',type,'memberFixture',member_fixture,
      'outcome',outcome,'hasTaskId',has_task_id,'hasRunId',has_run_id) ORDER BY ord)
      FROM (SELECT * FROM trace_events ORDER BY ord LIMIT 100) x),'[]'::jsonb)),
  'delegation',jsonb_build_object('bindings',(SELECT count(*) FROM task_bindings),
    'receipts',(SELECT count(*) FROM task_receipts),
    'foreignOwnerBindings',(SELECT count(*) FROM task_bindings WHERE NOT owned),
    'foreignOwnerReceipts',(SELECT count(*) FROM task_receipts WHERE NOT owned),
    'entriesTruncated',(SELECT count(*)>20 FROM task_bindings) OR (SELECT count(*)>20 FROM task_receipts),
    'bindingRows',COALESCE((SELECT jsonb_agg(jsonb_build_object('issueId',CASE WHEN owned THEN issue_id ELSE NULL END,
      'owned',owned,'expectedReporter',expected_reporter,'expectedExecutionBot',expected_execution_bot,'createdAt',created_at))
      FROM (SELECT * FROM task_bindings ORDER BY created_at LIMIT 20) x),'[]'::jsonb),
    'receiptRows',COALESCE((SELECT jsonb_agg(jsonb_build_object('issueId',CASE WHEN owned THEN issue_id ELSE NULL END,
      'owned',owned,'expectedReporter',expected_reporter,'operation',operation,'createdAt',created_at))
      FROM (SELECT * FROM task_receipts ORDER BY created_at LIMIT 20) x),'[]'::jsonb)),
  'cancellationFeedbackCount',(SELECT count(*) FROM scope s JOIN group_decision_feedback f
    ON f."conversationId"=s.group_id AND f."messageId"=s.message_id AND f."userId"=s.owner_id
    AND f.source='human_cancellation' AND f.kind='cancelled_turn'),
  'activeSession',jsonb_build_object('source','exact_group_advisory_lock',
    'locks',(SELECT count(*) FROM worker_locks),'held',(SELECT count(*) FROM worker_locks WHERE granted),
    'waiters',(SELECT count(*) FROM worker_locks WHERE NOT granted),
    'rowsTruncated',(SELECT count(*)>20 FROM worker_locks),
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('pid',pid,'granted',granted,'mode',mode,'activityVisible',activity_visible,
      'groupWorker',group_worker,'state',state,'waitEventType',wait_event_type,'backendStart',backend_start,'stateChangedAt',state_change))
      FROM (SELECT * FROM worker_locks ORDER BY pid LIMIT 20) x),'[]'::jsonb)),
  'remoteProviderBillingStoppedProven',false,
  'verdict','snapshot_only_requires_matching_host_terminal_and_stop_receipt'
) AS audit;
