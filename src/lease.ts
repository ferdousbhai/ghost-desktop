import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopError } from "./errors.js";
import { runtimeDir } from "./session.js";

/** How long a holder keeps the desktop after its last input. */
export const LEASE_IDLE_MS = 15_000;

const MUTEX_STALE_MS = 2_000;

interface LeaseRecord {
  holder: string;
  lastUsedAt: number;
}

/**
 * Who may steer the one desktop right now, shared by every ghost-desktop
 * process of this user through `$XDG_RUNTIME_DIR/ghost-desktop/lease.json`.
 * An input claims it for the caller; another caller's input fails `busy`
 * naming the holder until it has been idle {@link LEASE_IDLE_MS}. Reads never
 * claim or wait.
 */
export class DesktopLease {
  private readonly file: string;
  private readonly mutex: string;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, "lease.json");
    this.mutex = join(dir, "lease.lock");
  }

  /** The holder and its idle time, or null when the desktop is free. */
  peek(): { holder: string; idleMs: number } | null {
    const record = this.read();
    if (!record) return null;
    const idleMs = this.now() - record.lastUsedAt;
    return idleMs >= LEASE_IDLE_MS ? null : { holder: record.holder, idleMs };
  }

  /** Claim or renew for `caller`, or throw `busy` naming the holder. */
  async claim(caller: string): Promise<void> {
    await this.locked(() => {
      const held = this.peek();
      if (held && held.holder !== caller) {
        const waitS = Math.ceil((LEASE_IDLE_MS - held.idleMs) / 1000);
        throw new DesktopError(
          "busy",
          `Another agent (${held.holder}) is steering the desktop. Looking still works; `
          + `input frees up after it has been idle ${waitS}s more.`,
          { holder: held.holder, retryAfterMs: LEASE_IDLE_MS - held.idleMs },
        );
      }
      const temp = `${this.file}.${process.pid}`;
      writeFileSync(temp, JSON.stringify({ holder: caller, lastUsedAt: this.now() } satisfies LeaseRecord), { mode: 0o600 });
      renameSync(temp, this.file);
    });
  }

  private read(): LeaseRecord | null {
    try {
      const record = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LeaseRecord>;
      return typeof record.holder === "string" && typeof record.lastUsedAt === "number" ? record as LeaseRecord : null;
    } catch {
      return null;
    }
  }

  // An exclusive-create file is the cross-process mutex; one left by a crashed
  // process is broken after MUTEX_STALE_MS, far longer than any claim takes.
  private async locked<T>(body: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const deadline = this.now() + MUTEX_STALE_MS * 2;
    for (;;) {
      try {
        closeSync(openSync(this.mutex, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (this.now() - statSync(this.mutex).mtimeMs > MUTEX_STALE_MS) rmSync(this.mutex, { force: true });
        } catch {}
        if (this.now() > deadline) throw new DesktopError("failed", "The desktop lease file stayed locked; try again.");
        await Bun.sleep(5);
      }
    }
    try {
      return body();
    } finally {
      rmSync(this.mutex, { force: true });
    }
  }
}

export function leaseDir(env: NodeJS.ProcessEnv): string {
  return join(runtimeDir(env), "ghost-desktop");
}
