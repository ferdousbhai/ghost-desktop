import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolServer {
  name: string;
  version: string;
  tools: readonly unknown[];
  /** `client` is the name the client gave in `initialize`. */
  call(name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined, client: string | undefined): Promise<ToolResult>;
}

/** Answered when a client names no protocol version; otherwise its own is echoed. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Serve tools over MCP's stdio transport: one JSON-RPC 2.0 message per line.
 * Only what a tools server needs is answered (initialize, ping, tools/list,
 * tools/call); notifications are ignored. Resolves when input ends.
 */
export async function serveTools(server: ToolServer, input: Readable, write: (line: string) => void): Promise<void> {
  let client: string | undefined;
  const reply = (id: unknown, body: object) => write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const info = params.clientInfo as { name?: unknown } | undefined;
        client = typeof info?.name === "string" ? info.name : undefined;
        return {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: server.version },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: server.tools };
      case "tools/call":
        return server.call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>, params._meta as Record<string, unknown> | undefined, client);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  };
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // Notifications and responses carry nothing a tools server acts on.
    if (message.id === undefined || typeof message.method !== "string") continue;
    const { id } = message;
    answer(message.method, (message.params ?? {}) as Record<string, unknown>).then(
      (result) => reply(id, { result }),
      (error: { code?: number; message?: string }) => reply(id, { error: { code: error.code ?? -32603, message: error.message ?? String(error) } }),
    );
  }
}
