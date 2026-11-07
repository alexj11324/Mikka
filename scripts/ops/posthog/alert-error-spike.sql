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
        SELECT service_name, trace_id, span_id, parent_span_id, is_root_span, name, status_code,
            toFloatOrNull(attributes['http.response.status_code']) AS http_status,
            coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') AS route,
            coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), 'unknown_error') AS error_code
        FROM posthog.trace_spans
        WHERE timestamp >= evaluated_hour - INTERVAL 8 DAY AND timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND service_name = 'mikka-web'
          AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
          AND (is_root_span OR status_code = 2 AND name IN (
              'http GET', 'http POST', 'world.hooks.getByToken', 'hook.resume', 'workflow.replay.load',
              'world.events.create wait_created', 'world.events.create step_started', 'world.events.create run_started'))
    ),
    workflow_traces AS (
        -- Keep ancestry in each trace so matching does not rescan the historical window.
        SELECT service_name, trace_id,
            groupArrayIf((span_id, parent_span_id, name, route, error_code, http_status), status_code = 2) AS errors
        FROM workflow_spans
        WHERE service_name = 'mikka-web'
        GROUP BY service_name, trace_id
        HAVING countIf(is_root_span AND (status_code = 2 OR http_status >= 400)) = 0
           AND countIf(is_root_span AND status_code != 2 AND (
               (name = 'workflow.route.flow' AND route = '/.well-known/workflow/v1/flow'
                OR name = 'GET /api/cron/reconcile' AND route = '/api/cron/reconcile')
               AND http_status >= 200 AND http_status < 300
               OR name = 'after:workflow-wake' AND route = 'after:workflow-wake')) > 0
    ),
    handled_attempts AS (
        -- Error tuple fields are span id, parent id, name, route, code and HTTP status.
        SELECT service_name, trace_id, errors,
            arrayFilter(c ->
                (c.3 = 'http POST' AND c.4 = '/.well-known/workflow/v1/flow'
                 AND (c.6 = 409 AND c.5 = 'HTTP 409' OR c.6 = 410 AND c.5 = 'HTTP 410')
                 OR c.3 = 'http GET' AND c.6 = 404 AND c.5 = 'not-found' AND c.4 IN ('cron:reconcile', 'after:workflow-wake'))
                AND arrayExists(p -> p.1 = c.2 AND p.5 = 'unknown_error' AND p.4 = c.4 AND (
                    c.6 = 409 AND p.3 IN ('world.events.create wait_created', 'world.events.create step_started', 'world.events.create run_started')
                    OR c.6 = 410 AND p.3 = 'world.events.create run_started'
                    OR c.6 = 404 AND p.3 = 'world.hooks.getByToken'), errors), errors) AS clients
        FROM workflow_traces
    ),
    handled_parents AS (
        SELECT service_name, trace_id, errors, clients,
            arrayFilter(p -> has(arrayMap(c -> c.2, clients), p.1), errors) AS parents
        FROM handled_attempts
    ),
    handled_spans AS (
        SELECT service_name, trace_id,
            arrayJoin(arrayConcat(
                arrayMap(c -> c.1, clients),
                arrayMap(p -> p.1, parents),
                arrayMap(g -> g.1, arrayFilter(g -> g.5 = 'unknown_error' AND (
                    g.3 = 'hook.resume' AND arrayExists(p -> p.2 = g.1 AND p.3 = 'world.hooks.getByToken', parents)
                    OR g.3 = 'workflow.replay.load' AND arrayExists(p -> p.2 = g.1 AND p.3 = 'world.events.create run_started', parents)), errors))
            )) AS span_id
        FROM handled_parents
    ),
    service_start AS (
        SELECT service_name, min(timestamp) AS first_seen,
            groupUniqArray(toStartOfHour(timestamp)) AS observed_hours,
            countIf(timestamp >= evaluated_hour) > 0 AS current_service_observed
        FROM spans GROUP BY service_name
    ),
    service_coverage AS (
        SELECT service_name, current_service_observed,
            arrayFilter(h -> h >= evaluated_hour - INTERVAL 7 DAY
                AND h >= toStartOfHour(first_seen) + INTERVAL 1 HOUR AND h < evaluated_hour, observed_hours) AS covered_hours
        FROM service_start
    ),
    hourly AS (
        SELECT service_name, error_code, toStartOfHour(timestamp) AS hour, sum(sample_weight) AS estimated_errors,
            arrayStringConcat(arraySlice(groupUniqArray(route), 1, 5), ', ') AS example_routes
        FROM spans WHERE status_code = 2 AND timestamp >= evaluated_hour - INTERVAL 7 DAY
          AND (service_name, trace_id, span_id) NOT IN (SELECT service_name, trace_id, span_id FROM handled_spans)
        GROUP BY service_name, error_code, hour
    ),
    per_code AS (
        SELECT service_name, error_code, groupArray((hour, estimated_errors)) AS hour_counts,
            sumIf(estimated_errors, hour = evaluated_hour) AS current_errors,
            anyIf(example_routes, hour = evaluated_hour) AS example_routes
        FROM hourly GROUP BY service_name, error_code
    ),
    metrics AS (
        SELECT p.service_name AS service_name, p.error_code AS error_code,
            length(s.covered_hours) AS covered_hours, s.current_service_observed AS current_service_observed,
            p.current_errors AS current_errors, p.example_routes AS example_routes,
            if(length(s.covered_hours) = 0, 0,
                arrayReduce('median', arrayMap(h -> tupleElement(arrayFirst(c -> c.1 = h, p.hour_counts), 2), s.covered_hours))) AS median_errors,
            greatest(3 * median_errors, 50) AS threshold_errors
        FROM per_code p JOIN service_coverage s ON p.service_name = s.service_name
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
