SELECT if(count() = 0, 0, argMax(if(
  toFloat(properties.collection_healthy) = 1
  AND properties.latest_hour_bytes IS NOT NULL
  AND properties.daily_budget_ratio IS NOT NULL,
  1, 0), timestamp)) AS value
FROM events
WHERE event = 'mikka_ops_snapshot'
  AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 1 HOUR