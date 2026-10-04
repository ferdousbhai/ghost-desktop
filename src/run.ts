import { DesktopError, type DesktopErrorCode } from "./errors.js";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Raw stdout, when `binary` asked for it. */
  readonly bytes?: Uint8Array;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /** Return raw stdout bytes (images) instead of text. */
  readonly binary?: boolean;
}

/** Runs one external command without a shell; a missing binary is `unavailable`. */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>;

export const runCommand: Runner = async (argv, options = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new DesktopError("unavailable", `${argv[0]} is not installed.`, { binary: argv[0] });
  }
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 10_000);
  try {
    const [out, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    const bytes = new Uint8Array(out);
    return options.binary ? { code, stdout: "", stderr, bytes } : { code, stdout: new TextDecoder().decode(bytes), stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** Run and require exit 0, or throw `code` (default `failed`) naming the command and its stderr. */
export async function runChecked(run: Runner, argv: readonly string[], options?: RunOptions & { code?: DesktopErrorCode }) {
  const result = await run(argv, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    throw new DesktopError(options?.code ?? "failed", `${argv[0]} failed${detail ? `: ${detail}` : ""}.`, { argv: [...argv], code: result.code });
  }
  return result;
}
