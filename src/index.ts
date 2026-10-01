import { createAtspi } from "./atspi.js";
import { createCapture } from "./capture.js";
import { createDesktop } from "./desktop.js";
import { createHypr } from "./hypr.js";
import { DesktopLease, leaseDir } from "./lease.js";
import { runCommand } from "./run.js";
import { openVirtualPointer } from "./wayland.js";

export { ACT_VERBS, createDesktop, type ActArgs, type ActStep, type Desktop, type LookArgs } from "./desktop.js";
export { DesktopError, type DesktopErrorCode } from "./errors.js";
export { ACT, LOOK, TOOLS, callTool, createServer } from "./server.js";

/** The desktop of the session this process runs in. */
export function openDesktop(env: NodeJS.ProcessEnv = process.env) {
  return createDesktop({
    hypr: createHypr(runCommand, env),
    capture: createCapture(runCommand),
    atspi: () => createAtspi({ env }),
    pointer: () => openVirtualPointer(env),
    lease: new DesktopLease(leaseDir(env)),
    run: runCommand,
    env,
  });
}
