/** Single reviewed code gate. No browser, tool input or environment override. */
export const PERSONAL_WRITES_ENABLED: boolean = false

/** A single code gate shared by Workflow and Node, never model-controlled. */
export function personalWritesEnabled():boolean { return PERSONAL_WRITES_ENABLED }
