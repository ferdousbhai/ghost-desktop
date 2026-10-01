#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../package.json" with { type: "json" };
import { createAtspi } from "./atspi.js";
import { createCapture } from "./capture.js";
import { createDesktop } from "./desktop.js";
import { createHypr } from "./hypr.js";
import { DesktopLease, leaseDir } from "./lease.js";
import { runCommand } from "./run.js";
import { createServer } from "./server.js";
import { sessionEnv } from "./session.js";
import { openVirtualPointer } from "./wayland.js";

// The runtime build stamps the release version; a source checkout reads its manifest.
const version = process.env.GHOSTD_VERSION ?? packageJson.version;

if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}

// Children (grim, wtype) inherit the session too, so fill it in where they read it.
Object.assign(process.env, sessionEnv(process.env));
const env = process.env;
const desktop = createDesktop({
  hypr: createHypr({ env }),
  capture: createCapture(runCommand),
  atspi: () => createAtspi(env),
  pointer: () => openVirtualPointer(env),
  lease: new DesktopLease(leaseDir(env)),
  run: runCommand,
});
const server = createServer(desktop, version);
const { promise: closed, resolve } = Promise.withResolvers<void>();
server.onclose = resolve;
process.stdin.once("end", () => void server.close().then(resolve, resolve));
await server.connect(new StdioServerTransport());
await closed;
await desktop.close();
process.exit(0);
