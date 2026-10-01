#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../package.json" with { type: "json" };
import { createServer, openDesktop } from "./index.js";

if (process.argv.includes("--version")) {
  console.log(packageJson.version);
  process.exit(0);
}

const desktop = openDesktop();
const server = createServer(desktop, packageJson.version);
const { promise: closed, resolve } = Promise.withResolvers<void>();
server.onclose = resolve;
process.stdin.once("end", () => void server.close().then(resolve, resolve));
await server.connect(new StdioServerTransport());
await closed;
await desktop.close();
process.exit(0);
