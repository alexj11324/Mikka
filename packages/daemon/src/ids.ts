// Ids the server hands the daemon (run ids, fixture names) end up in file
// paths, git branch names and URLs. They are only accepted in this shape, so
// a hostile or buggy server cannot point a path outside the daemon's dirs.
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value)
}

export class UnsafeIdError extends Error {
  constructor(
    readonly kind: string,
    readonly value: unknown
  ) {
    super(
      `Refusing ${kind} ${JSON.stringify(value)}: only letters, digits, "_" and "-" (1-64 characters) are allowed`
    )
    this.name = "UnsafeIdError"
  }
}

export function assertSafeId(kind: string, value: unknown): string {
  if (!isSafeId(value)) throw new UnsafeIdError(kind, value)
  return value
}
