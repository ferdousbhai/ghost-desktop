import { connect, type Socket } from "node:net";
import { DesktopError } from "./errors.js";

/** The graphical session's runtime directory, where every desktop socket lives. */
export function runtimeDir(env: NodeJS.ProcessEnv): string {
  const dir = env.XDG_RUNTIME_DIR;
  if (!dir) throw new DesktopError("unavailable", "XDG_RUNTIME_DIR is unset; run inside the graphical session.");
  return dir;
}

/** A connected Unix socket, or `unavailable` naming what could not be reached. */
export function connectUnix(path: string, what: string, timeoutMs = 3000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const fail = (reason: string) => {
      socket.destroy();
      reject(new DesktopError("unavailable", `${what} is unreachable at ${path}: ${reason}`));
    };
    const timer = setTimeout(() => fail("no answer"), timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      fail(error.message);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

/**
 * Bytes received but not yet parsed, for a wire client. A chunk is appended
 * without re-copying what is pending; parsed bytes are dropped from the front.
 */
export class ByteQueue {
  private buffer = Buffer.alloc(4096);
  private head = 0;
  private tail = 0;

  /** Append a chunk and return everything pending, as a view. */
  push(chunk: Uint8Array): Buffer {
    const pending = this.tail - this.head;
    if (this.tail + chunk.length > this.buffer.length) {
      const target = pending + chunk.length > this.buffer.length ? Buffer.alloc(Math.max(this.buffer.length * 2, pending + chunk.length)) : this.buffer;
      this.buffer.copy(target, 0, this.head, this.tail);
      this.buffer = target;
      this.head = 0;
      this.tail = pending;
    }
    this.buffer.set(chunk, this.tail);
    this.tail += chunk.length;
    return this.buffer.subarray(this.head, this.tail);
  }

  /** Drop the first `count` pending bytes, once they are parsed. */
  consume(count: number): void {
    this.head += count;
    if (this.head === this.tail) this.head = this.tail = 0;
  }
}
