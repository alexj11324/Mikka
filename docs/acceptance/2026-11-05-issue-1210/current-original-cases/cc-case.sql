SELECT jsonb_build_object(
  'observedAt', clock_timestamp(),
  'task', (SELECT jsonb_build_object('id',id,'ownerId',"userId",'issueId',"issueId",'botId',"botId",'stage',stage,'status',status,'revision',revision,'candidateId',"candidateId",'updatedAt',"updatedAt") FROM factory_tasks WHERE id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND "userId"='XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'),
  'question', (SELECT jsonb_build_object('id',id,'taskId',"taskId",'kind',kind,'stage',stage,'status',status,'revision',revision,'answerId',"answerId",'answerSource',"answerSource",'continuationRunId',"continuationRunId",'answeredAt',"answeredAt",'expiresAt',"expiresAt",'updatedAt',"updatedAt") FROM factory_questions WHERE id='31b87a5f-7be6-49e9-9031-126dd2144007' AND "userId"='XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'),
  'runStatusCounts', (SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM agent_runs WHERE "userId"='XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ' AND "issueId"='0b9e6f79-790b-4931-aa54-2f45f5d142de' GROUP BY status) s),
  'unexpiredRunLeases', (SELECT count(*) FROM agent_runs WHERE "userId"='XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ' AND "issueId"='0b9e6f79-790b-4931-aa54-2f45f5d142de' AND "leaseExpiresAt">now())
) AS observation
