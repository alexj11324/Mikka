/** Legacy task creators sometimes stored a machine contract as the entire description. */
export function isLegacyTaskInstruction(body: string): boolean {
  return body.length >= 1000 && /\bsha-?256\b|file contract|文件契约|Before editing, compare this task with the actual Git origin/i.test(body)
}
