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
