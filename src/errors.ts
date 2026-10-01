/**
 * The one error type every desktop operation throws. `code` is stable for
 * callers; `message` is written for the model and says what to do next.
 *
 * - `unavailable`: a backend, binary, or protocol this machine lacks.
 * - `locked`: the session is locked, or its lock state is unknown.
 * - `busy`: another caller holds the desktop lease.
 * - `not_found`: no window, element, or ref matches.
 * - `invalid`: malformed arguments.
 * - `failed`: the desktop refused or an external command failed.
 */
export type DesktopErrorCode = "unavailable" | "locked" | "busy" | "not_found" | "invalid" | "failed";

export class DesktopError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DesktopError";
  }

  /** Any thrown value as a DesktopError; one that is not already is `failed`. */
  static from(error: unknown): DesktopError {
    return error instanceof DesktopError ? error : new DesktopError("failed", error instanceof Error ? error.message : String(error));
  }
}
