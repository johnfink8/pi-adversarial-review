export type RecordLike = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One rendering of a failure, shared by every module that reports one. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A name safe to use as a filename.
 *
 * One definition because it decides where on disk a thing lives: reviewer
 * reports, repository keys in the review store, and temp prompt files all derive
 * a name this way, and a divergent copy silently points at a different file.
 */
export function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}
