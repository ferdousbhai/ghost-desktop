import { DesktopError } from "./errors.js";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly stdin?: string;
  /** Return raw stdout bytes (images) instead of text. */
  readonly binary?: boolean;
  /**
   * Leave stdout and stderr unread. For commands that fork a helper which
   * outlives them (wl-copy keeps serving the clipboard), whose inherited pipe
   * would otherwise never close.
   */
  readonly detached?: boolean;
}

/** Runs one external command without a shell; a missing binary is `unavailable`. */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult & { bytes?: Uint8Array }>;

export const runCommand: Runner = async (argv, options = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: options.detached ? "ignore" : "pipe",
      stderr: options.detached ? "ignore" : "pipe",
    });
  } catch {
    throw new DesktopError("unavailable", `${argv[0]} is not installed.`, { binary: argv[0] });
  }
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 10_000);
  try {
    if (options.detached) return { code: await proc.exited, stdout: "", stderr: "" };
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    const bytes = new Uint8Array(out);
    return {
      code,
      stdout: options.binary ? "" : new TextDecoder().decode(bytes),
      stderr: err,
      ...(options.binary ? { bytes } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Run and require exit 0, or throw `failed` naming the command and its stderr. */
export async function runChecked(run: Runner, argv: readonly string[], options?: RunOptions) {
  const result = await run(argv, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    throw new DesktopError("failed", `${argv[0]} failed${detail ? `: ${detail}` : ""}.`, { argv: [...argv], code: result.code });
  }
  return result;
}
