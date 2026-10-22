// Workspace data export (ORV-181): the settings page downloads what the
// caller may see as CSV or JSON. One GET, so the desktop only needs the
// short-lived JWT it already sends to Zero and the relay.
//
// CSV holds one entity per file (a spreadsheet has one table); JSON can hold
// everything in one file for a round trip.

export const EXPORT_FORMATS = ["csv", "json"] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** `workspace` is the whole workspace; the other two narrow by row. */
export const EXPORT_SCOPES = ["workspace", "team", "project"] as const
export type ExportScope = (typeof EXPORT_SCOPES)[number]

/**
 * What the file holds. `all` is JSON-only: it writes issues, projects and
 * comments together. CSV with `all` is refused rather than silently
 * dropping two of them.
 */
export const EXPORT_ENTITIES = [
  "all",
  "issues",
  "projects",
  "comments",
] as const
export type ExportEntity = (typeof EXPORT_ENTITIES)[number]

export const EXPORT_ROUTES = {
  download: "/v1/export",
} as const
