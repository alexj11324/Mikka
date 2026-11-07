WITH
    toStartOfHour(now()) - INTERVAL 1 HOUR AS evaluated_hour,
    spans AS (
        SELECT timestamp, service_name, status_code, trace_id, span_id,
            1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1) AS sample_weight,
            coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') AS route,
            coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), 'unknown_error') AS error_code
        FROM posthog.trace_spans
        WHERE timestamp >= evaluated_hour - INTERVAL 8 DAY
          AND timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND service_name IN ('mikka-web', 'mikka-daemon')
          AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
    ),
    workflow_spans AS (
        SELECT raw.service_name, raw.trace_id, raw.span_id, raw.parent_span_id, raw.is_root_span, raw.links,
            CASE WHEN raw.name LIKE 'workflow.execute %' THEN 'workflow.execute'
                 WHEN raw.name LIKE 'step.execute %' THEN 'step.execute' ELSE raw.name END AS name,
            raw.status_code,
            toFloatOrNull(raw.attributes['http.response.status_code']) AS http_status,
            coalesce(nullIf(raw.attributes['mikka.route'], ''), 'unknown') AS route,
            coalesce(nullIf(raw.attributes['mikka.error.code'], ''), nullIf(raw.attributes['error.type'], ''), 'unknown_error') AS error_code
        FROM posthog.trace_spans raw
        WHERE raw.timestamp >= evaluated_hour - INTERVAL 8 DAY AND raw.timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND raw.service_name = 'mikka-web'
          AND (raw.resource_attributes['deployment.environment.name'] = 'production' OR raw.resource_attributes['deployment.environment'] = 'production')
          -- Keep the entry and finite SDK ancestor graph, including successful non-root entries.
          AND (raw.is_root_span OR raw.name IN (
              'workflow.route.flow', 'workflow.execute', 'workflow.run', 'step.execute',
              'workflow.replay.load', 'vqs.process', 'after:workflow-wake', 'cron:reconcile', 'GET /api/cron/reconcile', 'hook.resume')
              OR raw.name LIKE 'workflow.execute %' OR raw.name LIKE 'step.execute %'
              OR raw.status_code = 2 AND raw.name IN (
                  'http GET', 'http POST', 'world.hooks.getByToken',
                  'world.events.create wait_created', 'world.events.create step_started', 'world.events.create run_started'))
    ),
    successful_entries AS (
        SELECT service_name, trace_id, span_id, name, route
        FROM workflow_spans
        WHERE status_code IN (0, 1) AND error_code = 'unknown_error'
          AND name IN ('workflow.route.flow', 'GET /api/cron/reconcile')
          AND (name = 'workflow.route.flow' AND route = '/.well-known/workflow/v1/flow'
               OR name = 'GET /api/cron/reconcile' AND route = '/api/cron/reconcile')
          AND http_status >= 200 AND http_status < 300
    ),
    handled_attempts AS (
        SELECT c.service_name AS service_name, c.trace_id AS trace_id,
            c.span_id AS client_span_id, p.span_id AS sdk_span_id, p.name AS sdk_name,
            w.span_id AS wrapper_span_id, w.name AS wrapper_name,
            w.status_code AS wrapper_status, w.error_code AS wrapper_error
        FROM workflow_spans c JOIN workflow_spans p
          ON c.service_name = p.service_name AND c.trace_id = p.trace_id AND c.parent_span_id = p.span_id
        LEFT JOIN workflow_spans w
          ON p.service_name = w.service_name AND p.trace_id = w.trace_id AND p.parent_span_id = w.span_id
        LEFT JOIN workflow_spans owner
          ON w.service_name = owner.service_name AND w.trace_id = owner.trace_id
          AND owner.span_id = CASE WHEN w.name = 'hook.resume' THEN w.parent_span_id
                                  WHEN w.name = 'cron:reconcile' THEN w.span_id ELSE '' END
        LEFT JOIN successful_entries cron_entry
          ON owner.service_name = cron_entry.service_name AND owner.trace_id = cron_entry.trace_id
          AND owner.parent_span_id = cron_entry.span_id AND cron_entry.name = 'GET /api/cron/reconcile'
        LEFT JOIN workflow_spans invocation
          ON w.service_name = invocation.service_name AND w.trace_id = invocation.trace_id
          AND invocation.name = 'workflow.execute'
          AND invocation.span_id = CASE WHEN w.name = 'workflow.execute' THEN w.span_id
              WHEN w.name IN ('workflow.replay.load', 'workflow.run', 'step.execute') THEN w.parent_span_id ELSE '' END
        LEFT JOIN workflow_spans delivery_context
          ON invocation.service_name = delivery_context.service_name
          AND delivery_context.name IN ('workflow.route.flow', 'vqs.process')
          AND delivery_context.status_code IN (0, 1) AND delivery_context.error_code = 'unknown_error'
          -- Linked mode keeps the exact delivery parent; continuous mode links to it.
          -- @vercel/queue inserts one vqs.process span. Never search arbitrary ancestors.
          AND (invocation.trace_id = delivery_context.trace_id AND invocation.parent_span_id = delivery_context.span_id
               OR length(invocation.links) = 1 AND isValidJSON(arrayElement(invocation.links, 1))
                  -- links is Array(String); its JSON IDs use the table's base64 encoding.
                  AND JSONExtractString(arrayElement(invocation.links, 1), 'trace_id') = delivery_context.trace_id
                  AND JSONExtractString(arrayElement(invocation.links, 1), 'span_id') = delivery_context.span_id)
        LEFT JOIN successful_entries delivery
          ON delivery_context.service_name = delivery.service_name AND delivery_context.trace_id = delivery.trace_id
          AND delivery.name = 'workflow.route.flow'
          AND delivery.span_id = CASE WHEN delivery_context.name = 'workflow.route.flow' THEN delivery_context.span_id
                                     WHEN delivery_context.name = 'vqs.process' THEN delivery_context.parent_span_id ELSE '' END
        WHERE c.status_code = 2 AND p.status_code = 2 AND p.error_code = 'unknown_error' AND c.route = p.route
          AND (
              c.name = 'http POST' AND c.route = '/.well-known/workflow/v1/flow'
              AND (c.http_status = 409 AND c.error_code = 'HTTP 409'
                   AND p.name IN ('world.events.create wait_created', 'world.events.create step_started', 'world.events.create run_started')
                   OR c.http_status = 410 AND c.error_code = 'HTTP 410' AND p.name = 'world.events.create run_started')
              AND invocation.status_code IN (0, 1) AND invocation.error_code = 'unknown_error'
              AND delivery.name = 'workflow.route.flow'
              OR c.name = 'http GET' AND c.http_status = 404 AND c.error_code = 'not-found'
                 AND p.name = 'world.hooks.getByToken' AND owner.status_code IN (0, 1) AND owner.error_code = 'unknown_error'
                 AND (c.route = 'after:workflow-wake' AND w.name = 'hook.resume'
                      AND owner.name = 'after:workflow-wake' AND owner.route = 'after:workflow-wake'
                      OR c.route = 'cron:reconcile' AND w.name IN ('hook.resume', 'cron:reconcile')
                         AND owner.name = 'cron:reconcile' AND owner.route = 'cron:reconcile'
                         AND cron_entry.name = 'GET /api/cron/reconcile')
          )
    ),
    handled_spans AS (
        -- Expand each attempt once so CTE inlining does not repeat the ancestry scans.
        SELECT DISTINCT a.service_name AS service_name, a.trace_id AS trace_id,
            CASE r.role WHEN 'client' THEN a.client_span_id WHEN 'sdk' THEN a.sdk_span_id ELSE a.wrapper_span_id END AS span_id
        FROM handled_attempts a
        CROSS JOIN (SELECT 'client' AS role UNION ALL SELECT 'sdk' AS role UNION ALL SELECT 'wrapper' AS role) r
        WHERE r.role != 'wrapper' OR a.wrapper_status = 2 AND a.wrapper_error = 'unknown_error'
          AND (a.sdk_name = 'world.hooks.getByToken' AND a.wrapper_name = 'hook.resume'
               OR a.sdk_name = 'world.events.create run_started' AND a.wrapper_name = 'workflow.replay.load')
    ),
    service_start AS (
        SELECT service_name, min(timestamp) AS first_seen FROM spans GROUP BY service_name
    ),
    observed_hours AS (
        SELECT service_name, toStartOfHour(timestamp) AS hour
        FROM spans WHERE timestamp >= evaluated_hour - INTERVAL 7 DAY
        GROUP BY service_name, hour
    ),
    covered_hour_grid AS (
        SELECT h.service_name AS service_name, h.hour AS hour
        FROM observed_hours h JOIN service_start s ON h.service_name = s.service_name
        WHERE h.hour >= toStartOfHour(s.first_seen) + INTERVAL 1 HOUR AND h.hour < evaluated_hour
    ),
    hourly AS (
        SELECT service_name, error_code, toStartOfHour(timestamp) AS hour, sum(sample_weight) AS estimated_errors,
            arrayStringConcat(arraySlice(groupUniqArray(route), 1, 5), ', ') AS example_routes
        FROM spans WHERE status_code = 2 AND timestamp >= evaluated_hour - INTERVAL 7 DAY
          AND (service_name, trace_id, span_id) NOT IN (SELECT service_name, trace_id, span_id FROM handled_spans)
        GROUP BY service_name, error_code, hour
    ),
    sources AS (
        SELECT service_name, error_code FROM hourly GROUP BY service_name, error_code
    ),
    baseline AS (
        SELECT s.service_name AS service_name, s.error_code AS error_code,
            count() AS baseline_hours, median(coalesce(q.estimated_errors, 0)) AS median_errors
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.error_code = s.error_code AND q.hour = h.hour
        GROUP BY s.service_name, s.error_code
    ),
    current_hour AS (
        SELECT * FROM hourly WHERE hour = evaluated_hour
    ),
    current_service AS (
        SELECT service_name, count() AS observed_spans
        FROM spans WHERE timestamp >= evaluated_hour
        GROUP BY service_name
    ),
    metrics AS (
        SELECT s.service_name AS service_name, s.error_code AS error_code,
            coalesce(b.baseline_hours, 0) AS covered_hours,
            coalesce(cs.observed_spans, 0) > 0 AS current_service_observed,
            coalesce(c.estimated_errors, 0) AS current_errors,
            coalesce(c.example_routes, '') AS example_routes,
            coalesce(b.median_errors, 0) AS median_errors,
            greatest(3 * coalesce(b.median_errors, 0), 50) AS threshold_errors
        FROM sources s
        LEFT JOIN current_service cs ON s.service_name = cs.service_name
        LEFT JOIN baseline b ON s.service_name = b.service_name AND s.error_code = b.error_code
        LEFT JOIN current_hour c ON s.service_name = c.service_name AND s.error_code = c.error_code
    ),
    per_source AS (
SELECT
    if(NOT current_service_observed, NULL, if(covered_hours >= 24 AND current_errors > threshold_errors, 1, 0)) AS row_value,
    concat(service_name, ' code=', error_code, ' | UTC hour=', toString(toTimeZone(evaluated_hour, 'UTC')),
        ' | estimated error spans=', if(current_service_observed, toString(current_errors), 'unknown'),
        ' median=', if(covered_hours > 0, toString(round(median_errors, 1)), 'unavailable'),
        ' threshold=', toString(round(threshold_errors, 1)),
        ' | history=', toString(covered_hours), '/168h ', if(NOT current_service_observed, 'NO CURRENT TELEMETRY; evaluation suppressed', if(covered_hours >= 24, 'ready', 'WARMUP no error evaluation')),
        ' | routes (up to 5)=', example_routes,
        ' | fallback error.type/unknown_error; per-span 1/sample_rate weighting; legacy missing rate=0.1') AS row_source,
    service_name, error_code, current_errors, median_errors, threshold_errors, covered_hours, current_service_observed, example_routes, evaluated_hour AS hour_start
FROM metrics
    )
SELECT
    max(row_value) AS value,
    if(countIf(row_value = 1) > 0,
        concat(toString(countIf(row_value = 1)), ' breaching: ', arrayStringConcat(arraySlice(groupArrayIf(row_source, row_value = 1), 1, 5), ' || ')),
        concat('no breach | top: ', argMax(row_source, current_errors))) AS source,
    countIf(row_value = 1) AS breaching_sources,
    count() AS evaluated_sources,
    any(hour_start) AS hour_start
FROM (SELECT * FROM per_source ORDER BY row_value DESC, current_errors DESC, service_name, error_code)
