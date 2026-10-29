import { createHash } from 'node:crypto'

// These PR migrations move after the frozen main baseline with identical SQL.
// An earlier filename is usable only when Git shows one immutable payload.
// Names that carried multiple bodies cannot attest which body a database ran.
export const INTEGRATION_MIGRATION_IDENTITIES = [
  {
    "name": "20261029043630_composio_accounts.sql",
    "previous": "20261028154215_composio_accounts.sql",
    "sha256": "d7c0087befa184c76f6ac4908532d3eb8233303e31286a7dfbb8265d5ba5edc4",
    "ambiguousPreviousHashes": [
      "b6adfec8b0b5db0b7e653bcec5f9a42ca2b4a6db901012a5550b454cf559d4fa",
      "d7c0087befa184c76f6ac4908532d3eb8233303e31286a7dfbb8265d5ba5edc4"
    ]
  },
  {
    "name": "20261029043631_byos_account_label.sql",
    "previous": "20261028154607_byos_account_label.sql",
    "sha256": "d8908e19acb9c4ee3c06ff15f7be3df13cb65eeffba2b55dced181ad4d41b117",
    "ambiguousPreviousHashes": [
      "3b4b7663b7c371806d9a7203be120822cc7b2663506238453901b24b88c074ac",
      "d8908e19acb9c4ee3c06ff15f7be3df13cb65eeffba2b55dced181ad4d41b117"
    ]
  },
  {
    "name": "20261029043632_composio_account_email_checks.sql",
    "previous": "20261028161114_composio_account_email_checks.sql",
    "sha256": "b50f79948cd3cb0f3a592058d15cbd2b6075758f468b072f24c30b85052c321a"
  },
  {
    "name": "20261029043633_byos_connection_removed.sql",
    "previous": "20261028170412_byos_connection_removed.sql",
    "sha256": "108d1c2cd5544ad7429a733ca2099c5b959eaa6aacd4b25e42e4672120d73e54"
  },
  {
    "name": "20261029043634_group_turns.sql",
    "previous": "20261028173000_group_turns.sql",
    "sha256": "087d7344863fc23e6f1f9b8692728c9aa51b6075618567785ff9434343a71b07",
    "ambiguousPreviousHashes": [
      "087d7344863fc23e6f1f9b8692728c9aa51b6075618567785ff9434343a71b07",
      "520dfed89d6fda744ff258152def246bc19317165723481845a808bfb2070c73",
      "a43c86c59e2cf9a9f2eacd5593d9747f6f6506569827df8f0bc94afc20c513b1"
    ]
  },
  {
    "name": "20261029043635_pending_action_account.sql",
    "previous": "20261028180000_pending_action_account.sql",
    "sha256": "3ccea2dfdf25bbb566a8faf7df0a87397f2863a5891d64e2eb188297f199efbd"
  },
  {
    "name": "20261029043636_run_captures.sql",
    "previous": "20261028183500_run_captures.sql",
    "sha256": "87cff7bf01f27467cf46eb85190ecfffed834539fead95f07571f6d8da10dbeb"
  },
  {
    "name": "20261029043646_agent_external_write_policy.sql",
    "previous": "20261028203000_agent_external_write_policy.sql",
    "sha256": "58868e1fcc9fdb256c77e144bdfda8a461d797cc5c4f11f481197aa05118d158"
  },
  {
    "name": "20261029043647_workspace_external_write_policy.sql",
    "previous": "20261028213000_workspace_external_write_policy.sql",
    "sha256": "7e76838ecbce763d05e0983e0cb148232961772d80fb4d0bb7bc5c5b9a0456f9"
  },
  {
    "name": "20261029044000_factory_192_routing.sql",
    "previous": "20261028182316_factory_192_routing.sql",
    "sha256": "4a2570d9b3a2397a6d3c51436089f87a04f4fff2c5e5e99b333712269f56de2e"
  },
  {
    "name": "20261029044001_factory_192_question_source_identity.sql",
    "previous": "20261028182317_factory_192_questions.sql",
    "sha256": "0cd177fbe7ae0e061f4f276a113c7b57b7c94426e0f15b471afbcb2cf9c4e695"
  },
  {
    "name": "20261029044016_factory_public_consumers.sql",
    "previous": "20261029003000_factory_public_consumers.sql",
    "sha256": "fac25b384b65fa4df9ac8dad985aa8c6ac349ab9d6c5437547af762c71551aa1"
  },
  {
    "name": "20261029044017_run_publication_scope.sql",
    "previous": "20261029031000_run_publication_scope.sql",
    "sha256": "9b9b3a666dcd0ee1946f34419d683d43d964a33028ae7fbc2f1e169997aeced4"
  }
]

export const INTEGRATION_MIGRATION_EQUIVALENTS = Object.fromEntries(INTEGRATION_MIGRATION_IDENTITIES
  .filter(identity => !identity.ambiguousPreviousHashes)
  .map(identity => [identity.name, [identity.previous]]))

export function integratedMigrationApplied(name, applied, sql) {
  const identity = INTEGRATION_MIGRATION_IDENTITIES.find(item => item.name === name)
  if (!identity) return undefined
  if (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== identity.sha256)
    throw new Error(`migrate: integrated migration content changed: ${name}`)
  if (applied.has(name)) return true
  if (!applied.has(identity.previous)) return false
  if (identity.ambiguousPreviousHashes)
    throw new Error(`migrate: ambiguous integration migration history: ${identity.previous}; schema verification and an explicit repair plan are required`)
  return true
}
