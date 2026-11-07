SELECT formatDateTime(timestamp, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS span_timestamp_utc,
    lower(hex(base64Decode(trace_id))) AS trace_id_hex,
    if(match(attributes['mikka.run_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.run_id'] != '00000000-0000-0000-0000-000000000000', attributes['mikka.run_id'], NULL) AS run_id,
    if(match(attributes['mikka.thread_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.thread_id'] != '00000000-0000-0000-0000-000000000000', attributes['mikka.thread_id'], NULL) AS thread_id,
    if(match(attributes['mikka.task_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.task_id'] != '00000000-0000-0000-0000-000000000000', attributes['mikka.task_id'], NULL) AS task_id
FROM posthog.trace_spans
WHERE timestamp >= toDateTime('2026-10-31 12:45:08', 'UTC')
  AND timestamp < toDateTime('2026-11-07 12:45:08', 'UTC')
  AND service_name IN ('mikka-web', 'mikka-daemon')
  AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), resource_attributes['deployment.environment']) = 'production'
  AND ((match(attributes['mikka.run_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.run_id'] != '00000000-0000-0000-0000-000000000000')
        OR (match(attributes['mikka.thread_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.thread_id'] != '00000000-0000-0000-0000-000000000000')
        OR (match(attributes['mikka.task_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND attributes['mikka.task_id'] != '00000000-0000-0000-0000-000000000000'))
ORDER BY timestamp DESC, trace_id, span_id
LIMIT 1
