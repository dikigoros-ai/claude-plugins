// The few helpers several modules share, defined once.

/** The first line of an error's message, or of what was thrown in its place: never a stack. */
export function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0];
}

/**
 * An error's message, first line only, for a line that may reach the lawyer or a log; never a value
 * thrown in place of an Error, which could be a secret ("unknown error" instead).
 */
export function reason(err: unknown): string {
  return err instanceof Error ? firstLine(err) : "unknown error";
}

/** Whether `value` is a JSON object: neither null nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
