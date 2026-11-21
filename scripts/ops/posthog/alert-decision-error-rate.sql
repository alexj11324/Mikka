SELECT
    if(count() < 3, NULL, if(countIf(properties.$ai_is_error = true) / count() > 0.2, 1, 0)) AS value,
    concat('LiteLLM decisions: ', toString(countIf(properties.$ai_is_error = true)), '/', toString(count()), ' failed in the last hour; threshold >20%, minimum 3 calls') AS source
FROM events
WHERE event = '$ai_generation'
    AND properties.`mikka.ai.operation` = 'decision'
    AND properties.`mikka.ai.route` = 'litellm'
    AND timestamp >= now() - INTERVAL 1 HOUR
