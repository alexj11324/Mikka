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
    candidate_traces AS (
        -- A trace can only lose an error if it contains one of the client attempts below.
        -- Keep every workflow node of those traces for the existing parent/entry proofs.
        SELECT DISTINCT service_name, trace_id
        FROM workflow_spans
        WHERE status_code = 2 AND (
            name = 'http POST' AND route = '/.well-known/workflow/v1/flow' AND (
                http_status = 409 AND error_code = 'HTTP 409' OR http_status = 410 AND error_code = 'HTTP 410')
            OR http_status = 404 AND (
                name = 'http GET' AND error_code = 'not-found'
                    AND route IN ('cron:reconcile', 'after:workflow-wake', 'workflow:coordinatorWakeDeadline/nudgeWorkflow')
                OR name = 'http POST' AND error_code = 'HTTP 404' AND route = 'workflow:coordinatorWakeDeadline/nudgeWorkflow'))
    ),
    workflow_traces AS (
        SELECT service_name, trace_id,
            groupArray((span_id, parent_span_id, name, route, error_code, http_status, status_code)) AS nodes
        FROM workflow_spans WHERE (service_name, trace_id) IN (SELECT service_name, trace_id FROM candidate_traces)
        GROUP BY service_name, trace_id
    ),
    invocation_references AS (
        -- Match the exact local parent or a single valid link, including cross-trace delivery.
        SELECT service_name, trace_id, span_id AS invocation_id,
            arrayJoin(arrayConcat([(trace_id, parent_span_id)],
                if(length(links) = 1 AND isValidJSON(arrayElement(links, 1)),
                    [(JSONExtractString(arrayElement(links, 1), 'trace_id'), JSONExtractString(arrayElement(links, 1), 'span_id'))], []))) AS reference
        FROM workflow_spans
        WHERE name = 'workflow.execute' AND status_code IN (0, 1) AND error_code = 'unknown_error'
          AND (service_name, trace_id) IN (SELECT service_name, trace_id FROM candidate_traces)
    ),
    delivery_groups AS (
        -- Restrict the delivery side to traces actually referenced by a candidate invocation.
        -- Its successful flow can be in another trace that contains no errors of its own.
        SELECT service_name, trace_id,
            groupUniqArrayIf(span_id, name = 'workflow.route.flow'
                AND route = '/.well-known/workflow/v1/flow' AND http_status >= 200 AND http_status < 300) AS flow_ids,
            groupUniqArrayIf((span_id, parent_span_id), name = 'vqs.process') AS process_parents
        FROM workflow_spans
        WHERE name IN ('workflow.route.flow', 'vqs.process') AND status_code IN (0, 1) AND error_code = 'unknown_error'
          AND (service_name, trace_id) IN (SELECT service_name, tupleElement(reference, 1) FROM invocation_references)
        GROUP BY service_name, trace_id
    ),
    delivery_contexts AS (
        SELECT service_name, trace_id, arrayJoin(arrayConcat(flow_ids,
            arrayMap(p -> p.1, arrayFilter(p -> has(flow_ids, p.2), process_parents)))) AS span_id
        FROM delivery_groups
    ),
    proven_invocations AS (
        -- Resolve cross-trace links once per invocation, not once per error/client/wrapper.
        SELECT i.service_name AS service_name, i.trace_id AS trace_id, groupUniqArray(i.invocation_id) AS ids
        FROM invocation_references i JOIN delivery_contexts d
          ON i.service_name = d.service_name AND tupleElement(i.reference, 1) = d.trace_id AND tupleElement(i.reference, 2) = d.span_id
        GROUP BY i.service_name, i.trace_id
    ),
    trace_entries AS (
        SELECT t.service_name AS service_name, t.trace_id AS trace_id, t.nodes AS nodes,
            arrayFilter(n -> n.7 = 2, t.nodes) AS errors, coalesce(i.ids, []) AS invocation_ids,
            arrayMap(n -> n.1, arrayFilter(n -> n.3 = 'GET /api/cron/reconcile' AND n.4 = '/api/cron/reconcile'
                AND n.7 IN (0, 1) AND n.5 = 'unknown_error' AND n.6 >= 200 AND n.6 < 300, t.nodes)) AS cron_http_ids,
            arrayMap(n -> n.1, arrayFilter(n -> n.3 = 'after:workflow-wake' AND n.4 = 'after:workflow-wake'
                AND n.7 IN (0, 1) AND n.5 = 'unknown_error', t.nodes)) AS wake_ids,
            arrayMap(n -> n.1, arrayFilter(n -> n.3 = 'step.execute'
                AND n.7 IN (0, 1) AND n.5 = 'unknown_error', t.nodes)) AS step_ids
        FROM workflow_traces t LEFT JOIN proven_invocations i
          ON t.service_name = i.service_name AND t.trace_id = i.trace_id
    ),
    trace_anchors AS (
        SELECT service_name, trace_id, nodes, errors, wake_ids, step_ids,
            arrayConcat(invocation_ids, arrayMap(n -> n.1, arrayFilter(n ->
                n.3 IN ('workflow.replay.load', 'workflow.run', 'step.execute') AND has(invocation_ids, n.2), nodes))) AS flow_anchors,
            arrayMap(n -> n.1, arrayFilter(n -> n.3 = 'cron:reconcile' AND n.4 = 'cron:reconcile'
                AND n.7 IN (0, 1) AND n.5 = 'unknown_error' AND has(cron_http_ids, n.2), nodes)) AS cron_ids
        FROM trace_entries
    ),
    entry_proofs AS (
        SELECT service_name, trace_id, errors, flow_anchors,
            arrayConcat(arrayMap(c -> ('cron:reconcile', c), cron_ids),
                arrayMap(n -> (n.4, n.1), arrayFilter(n -> n.3 = 'hook.resume' AND (
                    n.4 = 'after:workflow-wake' AND has(wake_ids, n.2)
                    OR n.4 = 'cron:reconcile' AND has(cron_ids, n.2)
                    OR n.4 = 'workflow:coordinatorWakeDeadline/nudgeWorkflow' AND has(step_ids, n.2)), nodes))) AS hook_anchors
        FROM trace_anchors
    ),
    classified_parents AS (
        -- Index qualifying physical parents once per trace. A sibling cannot lend its proof to a client.
        SELECT service_name, trace_id, errors,
            arrayMap(p -> p.1, arrayFilter(p -> p.5 = 'unknown_error' AND p.4 = '/.well-known/workflow/v1/flow'
                AND p.3 IN ('world.events.create wait_created', 'world.events.create wait_completed',
                    'world.events.create step_started', 'world.events.create run_started') AND has(flow_anchors, p.2), errors)) AS conflict_parents,
            arrayMap(p -> p.1, arrayFilter(p -> p.5 = 'unknown_error' AND p.4 = '/.well-known/workflow/v1/flow'
                AND p.3 = 'world.events.create run_started' AND has(flow_anchors, p.2), errors)) AS expired_parents,
            arrayMap(p -> (p.4, p.1), arrayFilter(p -> p.5 = 'unknown_error' AND p.3 = 'world.hooks.getByToken'
                AND has(hook_anchors, (p.4, p.2)), errors)) AS missing_hook_parents,
            arrayMap(p -> p.1, arrayFilter(p -> p.5 = 'unknown_error'
                AND p.4 = 'workflow:coordinatorWakeDeadline/nudgeWorkflow' AND p.3 = 'world.events.create hook_received'
                AND has(hook_anchors, (p.4, p.2)), errors)) AS missing_event_parents
        FROM entry_proofs
    ),
    handled_attempts AS (
        SELECT service_name, trace_id, errors,
            arrayFilter(c -> c.3 = 'http POST' AND c.4 = '/.well-known/workflow/v1/flow' AND (
                c.6 = 409 AND c.5 = 'HTTP 409' AND has(conflict_parents, c.2)
                OR c.6 = 410 AND c.5 = 'HTTP 410' AND has(expired_parents, c.2))
                OR c.6 = 404 AND (
                    c.3 = 'http GET' AND c.5 = 'not-found' AND has(missing_hook_parents, (c.4, c.2))
                    OR c.3 = 'http POST' AND c.4 = 'workflow:coordinatorWakeDeadline/nudgeWorkflow'
                        AND c.5 = 'HTTP 404' AND has(missing_event_parents, c.2)), errors) AS clients
        FROM classified_parents
    ),
    handled_parents AS (
        SELECT service_name, trace_id, errors, clients,
            arrayFilter(p -> has(arrayMap(c -> c.2, clients), p.1), errors) AS parents
        FROM handled_attempts
    ),
    handled_spans AS (
        SELECT service_name, trace_id,
            arrayJoin(arrayConcat(arrayMap(c -> c.1, clients), arrayMap(p -> p.1, parents),
                arrayMap(g -> g.1, arrayFilter(g -> g.5 = 'unknown_error' AND (
                    g.3 = 'hook.resume' AND has(arrayMap(p -> p.2, arrayFilter(p ->
                        p.3 IN ('world.hooks.getByToken', 'world.events.create hook_received'), parents)), g.1)
                    OR g.3 = 'workflow.replay.load' AND has(arrayMap(p -> p.2, arrayFilter(p ->
                        p.3 = 'world.events.create run_started', parents)), g.1)), errors)))) AS span_id
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
