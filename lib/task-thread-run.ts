/** The Task thread excludes independent Factory checkers and group chats.
 * Keep the deferred coding_review_new_run trigger in sync with this predicate:
 * a Factory attempt binds its run after INSERT, within the same transaction.
 * The caller still supplies its own owner/tenant checks and latest ordering. */
export function taskThreadRunPredicate(alias: 'r' | 'newer') {
  return `${alias}.kind<>'group_chat'
    AND NOT EXISTS (SELECT 1 FROM factory_attempts fa WHERE fa."runId"=${alias}.id AND fa.stage IN ('review','verify','monitor'))`
}
