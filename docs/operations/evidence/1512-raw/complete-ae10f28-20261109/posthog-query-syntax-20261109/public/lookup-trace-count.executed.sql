SELECT count() AS trace_count
FROM (
    SELECT trace_id
    FROM posthog.trace_spans
    WHERE timestamp >= toDateTime('2026-11-08 00:00:00', 'UTC')
          AND timestamp < toDateTime('2026-11-08 00:00:01', 'UTC')
        AND service_name IN ('mikka-web', 'mikka-daemon')
        AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), resource_attributes['deployment.environment']) = 'production'
        AND (
            ('00000000-0000-0000-0000-000000000000' != '' AND attributes['mikka.run_id'] = '00000000-0000-0000-0000-000000000000')
            OR ('00000000-0000-0000-0000-000000000000' != '' AND attributes['mikka.thread_id'] = '00000000-0000-0000-0000-000000000000')
            OR ('00000000-0000-0000-0000-000000000000' != '' AND attributes['mikka.task_id'] = '00000000-0000-0000-0000-000000000000')
        )
    GROUP BY trace_id
) AS matched_traces