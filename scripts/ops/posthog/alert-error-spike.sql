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
        SELECT raw.service_name, raw.trace_id, raw.span_id, raw.parent_span_id, raw.links,
            CASE WHEN raw.name LIKE 'workflow.execute %' THEN 'workflow.execute'
                 WHEN raw.name LIKE 'workflow.run %' THEN 'workflow.run'
                 WHEN raw.name LIKE 'step.execute %' THEN 'step.execute' ELSE raw.name END AS name,
            raw.status_code,
            toFloatOrNull(raw.attributes['http.response.status_code']) AS http_status,
            coalesce(nullIf(raw.attributes['mikka.route'], ''), 'unknown') AS route,
            coalesce(nullIf(raw.attributes['mikka.error.code'], ''), nullIf(raw.attributes['error.type'], ''), 'unknown_error') AS error_code
        FROM posthog.trace_spans raw
        WHERE raw.timestamp >= evaluated_hour - INTERVAL 8 DAY AND raw.timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND raw.service_name = 'mikka-web'
          AND (raw.resource_attributes['deployment.environment.name'] = 'production' OR raw.resource_attributes['deployment.environment'] = 'production')
          AND (raw.name IN (
              'workflow.route.flow', 'vqs.process', 'workflow.execute', 'workflow.run', 'step.execute',
              'workflow.replay.load', 'after:workflow-wake', 'cron:reconcile', 'GET /api/cron/reconcile', 'hook.resume')
              OR raw.name LIKE 'workflow.execute %' OR raw.name LIKE 'workflow.run %' OR raw.name LIKE 'step.execute %'
              OR raw.status_code = 2 AND raw.name IN (
                  'http GET', 'http POST', 'world.hooks.getByToken',
                  'world.events.create wait_created', 'world.events.create wait_completed', 'world.events.create step_started',
                  'world.events.create run_started', 'world.events.create hook_received'))
    ),
    workflow_traces AS (
        -- Finite node tuple: id, parent, name, route, error, HTTP status, span status, links.
        -- Keep non-root entries. Success elsewhere in a trace is never an attempt's proof.
        SELECT service_name, trace_id,
            groupArray((span_id, parent_span_id, name, route, error_code, http_status, status_code, links)) AS nodes
        FROM workflow_spans GROUP BY service_name, trace_id
    ),
    delivery_contexts AS (
        -- A queue context proves only its exact successful flow parent, never its own origin link.
        SELECT DISTINCT service_name, trace_id,
            arrayJoin(arrayMap(d -> d.1, arrayFilter(d -> d.7 IN (0, 1) AND d.5 = 'unknown_error' AND (
                d.3 = 'workflow.route.flow' AND d.4 = '/.well-known/workflow/v1/flow' AND d.6 >= 200 AND d.6 < 300
                OR d.3 = 'vqs.process' AND arrayExists(f -> f.1 = d.2 AND f.3 = 'workflow.route.flow'
                    AND f.4 = '/.well-known/workflow/v1/flow' AND f.7 IN (0, 1) AND f.5 = 'unknown_error'
                    AND f.6 >= 200 AND f.6 < 300, nodes)), nodes))) AS span_id
        FROM workflow_traces
    ),
    invocations AS (
        SELECT service_name, trace_id,
            arrayJoin(arrayFilter(i -> i.3 = 'workflow.execute' AND i.7 IN (0, 1) AND i.5 = 'unknown_error', nodes)) AS invocation
        FROM workflow_traces
    ),
    invocation_references AS (
        -- Linked: exact local parent. Continuous: one valid link to the delivery or its vqs.process.
        -- JSON link IDs already use the table's native base64 representation.
        SELECT service_name, trace_id, invocation.1 AS invocation_id,
            arrayJoin(arrayConcat([(trace_id, invocation.2)],
                if(length(invocation.8) = 1 AND isValidJSON(arrayElement(invocation.8, 1)),
                    [(JSONExtractString(arrayElement(invocation.8, 1), 'trace_id'), JSONExtractString(arrayElement(invocation.8, 1), 'span_id'))], []))) AS reference
        FROM invocations
    ),
    proven_invocations AS (
        -- Resolve cross-trace links once per invocation, not once per error/client/wrapper.
        SELECT i.service_name AS service_name, i.trace_id AS trace_id, groupUniqArray(i.invocation_id) AS ids
        FROM invocation_references i JOIN delivery_contexts d
          ON i.service_name = d.service_name AND tupleElement(i.reference, 1) = d.trace_id AND tupleElement(i.reference, 2) = d.span_id
        GROUP BY i.service_name, i.trace_id
    ),
    entry_proofs AS (
        SELECT t.service_name AS service_name, t.trace_id AS trace_id, t.nodes AS nodes,
            arrayFilter(n -> n.7 = 2, t.nodes) AS errors, coalesce(i.ids, []) AS invocation_ids,
            arrayMap(o -> o.1, arrayFilter(o -> o.7 IN (0, 1) AND o.5 = 'unknown_error'
                AND o.3 = 'after:workflow-wake' AND o.4 = 'after:workflow-wake', t.nodes)) AS wake_ids,
            arrayMap(o -> o.1, arrayFilter(o -> o.7 IN (0, 1) AND o.5 = 'unknown_error'
                AND o.3 = 'cron:reconcile' AND o.4 = 'cron:reconcile'
                AND arrayExists(e -> e.1 = o.2 AND e.3 = 'GET /api/cron/reconcile' AND e.4 = '/api/cron/reconcile'
                    AND e.7 IN (0, 1) AND e.5 = 'unknown_error' AND e.6 >= 200 AND e.6 < 300, t.nodes), t.nodes)) AS cron_ids,
            -- The inner step span starts before stepMetadata; its route can still be flow.
            -- Only its hook/SDK/client descendants must carry the exact closed nudge label.
            arrayMap(o -> o.1, arrayFilter(o -> o.7 IN (0, 1) AND o.5 = 'unknown_error' AND o.3 = 'step.execute', t.nodes)) AS step_ids
        FROM workflow_traces t LEFT JOIN proven_invocations i
          ON t.service_name = i.service_name AND t.trace_id = i.trace_id
    ),
    handled_attempts AS (
        SELECT service_name, trace_id, errors,
            arrayFilter(c -> arrayExists(p -> p.1 = c.2 AND p.5 = 'unknown_error' AND p.4 = c.4 AND (
                c.3 = 'http POST' AND c.4 = '/.well-known/workflow/v1/flow'
                AND (c.6 = 409 AND c.5 = 'HTTP 409' AND p.3 IN (
                    'world.events.create wait_created', 'world.events.create wait_completed', 'world.events.create step_started', 'world.events.create run_started')
                    OR c.6 = 410 AND c.5 = 'HTTP 410' AND p.3 = 'world.events.create run_started')
                AND (has(invocation_ids, p.2) OR arrayExists(w -> w.1 = p.2
                    AND w.3 IN ('workflow.replay.load', 'workflow.run', 'step.execute') AND has(invocation_ids, w.2), nodes))
                OR c.6 = 404 AND (
                    c.3 = 'http GET' AND c.5 = 'not-found' AND p.3 = 'world.hooks.getByToken'
                      AND c.4 IN ('cron:reconcile', 'after:workflow-wake', 'workflow:coordinatorWakeDeadline/nudgeWorkflow')
                    OR c.3 = 'http POST' AND c.5 = 'HTTP 404' AND p.3 = 'world.events.create hook_received'
                      AND c.4 = 'workflow:coordinatorWakeDeadline/nudgeWorkflow')
                AND (c.4 = 'cron:reconcile' AND has(cron_ids, p.2)
                    OR arrayExists(w -> w.1 = p.2 AND w.3 = 'hook.resume' AND w.4 = c.4 AND (
                        c.4 = 'after:workflow-wake' AND has(wake_ids, w.2)
                        OR c.4 = 'cron:reconcile' AND has(cron_ids, w.2)
                        OR c.4 = 'workflow:coordinatorWakeDeadline/nudgeWorkflow' AND has(step_ids, w.2)), nodes))
            ), errors), errors) AS clients
        FROM entry_proofs
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
                    g.3 = 'hook.resume' AND arrayExists(p -> p.2 = g.1 AND p.3 IN ('world.hooks.getByToken', 'world.events.create hook_received'), parents)
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
