WITH latest AS (
    SELECT timestamp AS snapshot_at,
        toFloat(properties.collection_healthy) AS collection_healthy,
        toFloat(properties.provider_healthy) AS provider_healthy,
        toFloat(properties.today_bytes) AS today_bytes,
        parseDateTimeBestEffort(toString(properties.latest_hour_end)) AS reported_through
    FROM events
    WHERE event = 'mikka_ops_snapshot'
      AND properties.environment = 'production'
      AND timestamp >= now() - INTERVAL 1 DAY
    ORDER BY timestamp DESC
    LIMIT 1
), pace AS (
    SELECT *,
        toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 12, 2)) AS utc_hours,
        multiIf(toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 6, 2)) IN (1, 3, 5, 7, 8, 10, 12), 31, toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 6, 2)) IN (4, 6, 9, 11), 30, if(modulo(toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 1, 4)), 400) = 0 OR (modulo(toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 1, 4)), 4) = 0 AND modulo(toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 1, 4)), 100) != 0), 29, 28)) AS utc_month_days,
        dateDiff('minute', snapshot_at, now()) AS snapshot_age_minutes,
        dateDiff('minute', reported_through, now()) AS provider_age_minutes,
        today_bytes * 24 / greatest(toInt(substring(toString(toTimeZone(reported_through, 'UTC')), 12, 2)), 1) AS projected_daily_bytes
    FROM latest
), result AS (
    SELECT *,
        projected_daily_bytes * utc_month_days AS equivalent_monthly_bytes,
        collection_healthy = 1 AND provider_healthy = 1
            AND utc_hours >= 3 AND utc_hours <= 24
            AND snapshot_age_minutes >= 0 AND snapshot_age_minutes <= 60
            AND provider_age_minutes >= 0 AND provider_age_minutes <= 180
            AND reported_through <= snapshot_at
            AND substring(toString(toTimeZone(reported_through, 'UTC')), 1, 10) = substring(toString(toTimeZone(snapshot_at, 'UTC')), 1, 10)
            AND substring(toString(toTimeZone(snapshot_at, 'UTC')), 1, 10) = substring(toString(toTimeZone(now(), 'UTC')), 1, 10)
            AND today_bytes >= 0 AS eligible
    FROM pace
)
SELECT
    if(eligible, equivalent_monthly_bytes / 500000000000, NULL) AS value,
    concat('UTC daily run rate | today=', toString(round(today_bytes, 0)), ' bytes/', toString(utc_hours), ' reported hours',
        ' | projected day=', toString(round(projected_daily_bytes, 0)), ' bytes',
        ' | ', toString(utc_month_days), '-day equivalent=', toString(round(equivalent_monthly_bytes, 0)), ' bytes vs 500000000000 budget',
        ' | reported=', toString(toTimeZone(reported_through, 'UTC')),
        ' | snapshot age=', toString(snapshot_age_minutes), 'm; provider age=', toString(provider_age_minutes), 'm',
        ' | ', if(eligible, 'eligible', 'suppressed: stale/unhealthy/early UTC day')) AS source,
    today_bytes, utc_hours, projected_daily_bytes, equivalent_monthly_bytes, 500000000000 AS monthly_budget_bytes,
    snapshot_age_minutes, provider_age_minutes, reported_through, snapshot_at, eligible
FROM result