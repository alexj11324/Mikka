import { sql } from 'drizzle-orm'
import { DYNAMIC_TOOL_NAMES, TOOL_ERROR_TEXT_PATTERN, TOOL_IDENTIFIER_PATTERN, TOOL_IDENTIFIER_SOURCE, TOOL_OPERATION_CHARS, TOOL_SPACE, TOOL_TARGET_CHARS, TOOL_TARGET_KEYS } from './tool-metadata'

// Only fixed host constants form SQL below. Tool arguments and results are
// read as JSONB values; none of their text is interpolated into SQL.
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const string = (value: string) => "(case when jsonb_typeof(" + value + ") = 'string' then " + value + "#>>'{}' end)"
const normalized = (value: string) => "nullif(regexp_replace(regexp_replace(" + value + ", '[" + TOOL_SPACE + "]+', ' ', 'g'), '^ | $', '', 'g'), '')"
const rawWords = (value: string) => "(case when " + normalized(string(value)) + " is not null then " + string(value) + " end)"
const input = "(case when p->>'toolName' in (" + Object.keys(DYNAMIC_TOOL_NAMES).map(literal).join(', ') + ") then p#>'{input,arguments}' else p->'input' end)"
const targetFields = TOOL_TARGET_KEYS.map(key => {
  const value = rawWords("(" + input + ")->" + literal(key))
  if (key !== 'repo') return value
  const owner = rawWords("(" + input + ")->'owner'")
  return "(case when " + owner + " is not null and " + value + " is not null then " + owner + " || '/' || " + value + " else " + value + " end)"
})
const target = "left(" + normalized("coalesce(" + targetFields.join(', ') + ")") + ", " + (TOOL_TARGET_CHARS + 1) + ")"
const operation = "left(case p->>'toolName' " + Object.entries(DYNAMIC_TOOL_NAMES).map(([name, entry]) =>
  "when " + literal(name) + " then " + normalized(string("p#>" + literal('{input,' + entry.field + '}')))).join(' ') + " end, " + TOOL_OPERATION_CHARS + ")"

/** A bounded target plus the invoked dynamic operation's name, from the whole input. */
export const compactToolCallMetadata = sql.raw("jsonb_strip_nulls(jsonb_build_object('target', " + target + ", 'operationName', " + operation + "))")

const at = (path: string[]) => "p#>" + literal('{output,value' + (path.length ? ',' + path.join(',') : '') + '}')
const ownFailure = "(p#>>'{output,type}' like 'error%' or " + at(['error']) + " not in ('null'::jsonb, 'false'::jsonb, '\"\"'::jsonb) or " +
  at(['ok']) + " = 'false'::jsonb or " + at(['isError']) + " = 'true'::jsonb)"
const whenMcpError = (expression: string) => "(case when " + at(['isError']) + " = 'true'::jsonb then " + expression + " end)"
const valid = (value: string, pattern: string) => "(case when " + string(value) + " ~ " + literal(pattern) + " then " + string(value) + " end)"
const codePaths = [['errorCode'], ['error', 'code'], ['error'], ['code'], ['reason']]
const codeTexts = [
  ...codePaths.map(path => valid(at(path), TOOL_ERROR_TEXT_PATTERN)),
  ...codePaths.map(path => whenMcpError(valid(at(['structuredContent', ...path]), TOOL_ERROR_TEXT_PATTERN))),
  valid(at(['message']), TOOL_ERROR_TEXT_PATTERN),
  valid(at([]), TOOL_ERROR_TEXT_PATTERN),
]
const detailPaths = [['error', 'detail'], ['detail'], ['error', 'reason'], ['reason']]
const details = [
  ...detailPaths.map(path => valid(at(path), TOOL_IDENTIFIER_PATTERN)),
  ...detailPaths.map(path => whenMcpError(valid(at(['structuredContent', ...path]), TOOL_IDENTIFIER_PATTERN))),
].map(value => 'nullif(' + value + ', code)')
const codedText = 'coalesce(' + codeTexts.join(', ') + ')'
const codePattern = literal('^(' + TOOL_IDENTIFIER_SOURCE + ')')
const detailPattern = literal('\\((' + TOOL_IDENTIFIER_SOURCE + ')\\)$')

/**
 * A receipt's own error/ok/isError marker and its existing code/detail,
 * computed before the preview is cut. No code or reason is invented.
 */
export const compactToolResultMetadata = sql.raw("(select jsonb_strip_nulls(jsonb_build_object(" +
  "'status', case when failed then 'error' else 'done' end, " +
  "'errorCode', case when failed then code end, " +
  "'errorDetail', case when failed then coalesce(" + [...details, 'nullif(text_detail, code)'].join(', ') + ") end)) " +
  "from (select coalesce(" + ownFailure + ", false) as failed, substring(coded_text from " + codePattern + ") as code, " +
  "substring(coded_text from " + detailPattern + ") as text_detail from (select " + codedText + " as coded_text) receipt) metadata)")
