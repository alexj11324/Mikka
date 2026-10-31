# Older-backlog migration filenames

Before the first production merge, the nine unmerged migrations were renamed in the same dependency order to follow main’s `20261031040000` migration. The production migration ledger was checked read-only and contained none of their old filenames. SQL bytes were preserved; the hashes below identify the unchanged bodies. Runtime fixture file references use the new filenames.

Earlier isolated databases and CI evidence retain the old names and remain evidence for their original revisions. Do not replay the renamed bootstrap against those retained databases; use a fresh isolated bootstrap for new migration acceptance. No production or historical migration ledger was edited.

| Earlier filename | Current filename | SQL SHA-256 |
| --- | --- | --- |
| `20261031012940_workspace_model_admission.sql` | `20261031050729_workspace_model_admission.sql` | `a9831be3fd230e7f1f589d1be6d9e592c4f72594704e41ac1af7d804eb1385f2` |
| `20261031013401_audit_export_snapshots.sql` | `20261031050730_audit_export_snapshots.sql` | `98d41cc506f7101037081731e664afbd81e67a24ce81f83fa5bfe4b818449fa1` |
| `20261031015301_account_deletion_jobs.sql` | `20261031050731_account_deletion_jobs.sql` | `5b78619765dc6ac5765a00e77165013386eea7a2f1f6ded99578eab1746e8086` |
| `20261031015302_workspace_deletion_guards.sql` | `20261031050732_workspace_deletion_guards.sql` | `dd38d7c14aecf9ae36cef09a3c296b7d7547993de34e19d37dae2368c912d3a6` |
| `20261031020440_team_skill_metadata.sql` | `20261031050733_team_skill_metadata.sql` | `4ac8930a6fac2f4fdf2acc2e8d9acd4007974e8a54829f5e1722254acb7ec625` |
| `20261031020703_audit_retention_policy.sql` | `20261031050734_audit_retention_policy.sql` | `4630872f93bdab6d3a9e29096b07ddc144e22ceaf2e07f0b143c4370db8d48e3` |
| `20261031021420_archive_linear_on_personal_scope.sql` | `20261031050735_archive_linear_on_personal_scope.sql` | `9b41bdb2d334786ae83f5e3fe153f0b5d3f4393d73c0c2d60bfb74d0ba2ef7b3` |
| `20261031022001_ops_monitor_observations.sql` | `20261031050736_ops_monitor_observations.sql` | `686f2d5e0cc42620fe399895750f24e41cded3deefed050a4768667df18a1542` |
| `20261031022004_account_deletion_warnings.sql` | `20261031050737_account_deletion_warnings.sql` | `2128c56f92e4b5d8ea9f86170d0af07c1c677b1c2e264cffd975851d3dd57cdb` |

## Subsequent nightly batch

The unmerged follow-up and workspace-audit migrations were likewise renamed without SQL changes before integration. Their earlier local test receipts remain historical evidence; no production ledger was edited.

| Earlier filename | Current filename | SQL SHA-256 |
| --- | --- | --- |
| `20261031045310_monitor_followup_issues.sql` | `20261031053430_monitor_followup_issues.sql` | `6c77aa85ad7b303220368f408c1d29ee148cdf3afadafec3a544e09d97db3282` |
| `20261031045910_monitor_github_issue_links.sql` | `20261031053431_monitor_github_issue_links.sql` | `6f903b61355e4221aa2d9c2f2a7cbc785e100bad4f830e670162efd35af11469` |
| `20261031052204_workspace_audit_outbox.sql` | `20261031053432_workspace_audit_outbox.sql` | `e7c71f4ad884a47d1ef9ec43a0159f9ffd5f494abafda5e4fc6702b231dd0895` |
