/**
 * A thread's or task's title as a list row shows it (Alex 2026-11-06): without a leading issue key (ALEX-12, #1408,
 * [MIK-3]) and without a trailing date or time stamp (2026-11-06, 11/06 03:12, 20261106-0312). The stored title
 * stays as it is; a title that would be left empty keeps its original text.
 */
const LEADING_KEY = /^\s*(?:\[\s*)?(?:[A-Za-z][A-Za-z0-9]*-\d+|#\d+)(?:\s*\])?\s*[:：\-–—·|]?\s*/
const TRAILING_STAMP = new RegExp(
  '(?:^|\\s+|\\s*[-–—·|,，(（\\[]\\s*)' +
  '(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?' +
  '|(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\\d|3[01])(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?' +
  '|\\d{1,2}:\\d{2}(?::\\d{2})?' +
  '|\\d{8}(?:[-_T]?\\d{4,6})?)' +
  '\\s*[)）\\]]?\\s*$')

export function displayTitle(raw: string): string {
  let title = raw.trim()
  for (let i = 0; i < 2; i++) title = title.replace(LEADING_KEY, '')
  for (let i = 0; i < 2; i++) title = title.replace(TRAILING_STAMP, '')
  title = title.trim()
  return title || raw.trim()
}
