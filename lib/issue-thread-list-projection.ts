import { sql } from 'drizzle-orm'
import { agentRuns } from '@/lib/db/schema'
import { runFailureBrief } from './run-failure-projection'
import { runBotName, runTaskPrompt } from '@/lib/run-bot-name'

// The same whitespace set as JavaScript trim/\s, including NBSP and BOM.
// PostgreSQL's default btrim and locale-dependent \s are not that contract.
const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
const space = `[${whitespace}]`
const markdownPrefix = `^(?:#{1,6}${space}+|>${space}*|[-*+]${space}+|[0-9]+[.)]${space}+)+`
const markdownMarks = '(\\*\\*|__|' + String.fromCharCode(96) + '|~~)'

/** A bounded first meaningful line. projectIssueThreads applies the shared six-word / CJK limit. */
const title = sql<string | null>`(
  select left(clean.line,400)
  from string_to_table(${runTaskPrompt}, E'\\n') with ordinality as raw(line, position)
  cross join lateral (select btrim(regexp_replace(
    regexp_replace(btrim(raw.line, ${whitespace}), ${markdownPrefix}, ''),
    ${markdownMarks}, '', 'g'), ${whitespace}) as line) clean
  where clean.line<>'' order by raw.position limit 1
)`

/** Exactly runSummaryText: a nonblank string summary, otherwise the first nonblank error line. */
const summary = sql<string | null>`coalesce(
  case when jsonb_typeof(${agentRuns.report})='object' and jsonb_typeof(${agentRuns.report}->'summary')='string'
    then nullif(btrim(${agentRuns.report}->>'summary', ${whitespace}), '') end,
  (select btrim(raw.line, ${whitespace})
    from string_to_table(${agentRuns.error}, E'\\n') with ordinality as raw(line, position)
    where btrim(raw.line, ${whitespace})<>'' order by raw.position limit 1)
)`

/** List-only text; teammate rows never transfer their private prompt, report or error. */
export function issueThreadListText(viewerId: string) {
  return {
    failureDetails: runFailureBrief,
    name: sql<string>`case when ${agentRuns.userId}=${viewerId} then coalesce(${agentRuns.title}, ${title}, ${runBotName}) else '' end`,
    summary: sql<string | null>`case when ${agentRuns.userId}=${viewerId} then ${summary} end`,
  }
}
