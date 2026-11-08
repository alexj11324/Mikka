import messages from '../../../messages/zh-CN.json'

const RUN_ERRORS = messages.RunErrors as Record<string, Record<string, string> & { default: string }>

/**
 * A run's stored error as a person reads it (decision 2026-11-05-0330): the stored error leads with `code (detail)`;
 * a registered code gets its words from RunErrors (by detail when it has one), anything else the generic run_failed
 * line. The raw text stays for 详情 only, never in place of the line.
 */
export function runErrorLine(raw: string): { line: string; raw: string } {
  const match = /^([a-z][a-z0-9_]*)(?: \(([a-z0-9_]+)\))?/.exec(raw.trim())
  const copy = match ? RUN_ERRORS[match[1]!] : undefined
  const line = copy ? (match?.[2] && copy[match[2]]) || copy.default : RUN_ERRORS.run_failed!.default
  return { line, raw }
}
