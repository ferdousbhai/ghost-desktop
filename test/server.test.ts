import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Desktop } from "../src/desktop.js";
import { DesktopError } from "../src/errors.js";
import { serveTools, type ToolServer } from "../src/mcp.js";
import { ACT, LOOK, TOOLS, createServer } from "../src/server.js";

/** A client over MCP's stdio framing: `request` resolves with the response to its id. */
function connect(server: ToolServer) {
  const input = new PassThrough();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const served = serveTools(server, input, (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const send = (line: string) => input.write(`${line}\n`);
  const request = (method: string, params?: unknown) => {
    const id = ++next;
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    waiting.set(id, resolve);
    send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  };
  return { request, send, end: () => { input.end(); return served; } };
}

describe("ghost-desktop MCP server", () => {
  it("offers exactly two tools with a compact surface", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([LOOK, ACT]);
    // Every call pays for this text; growth is a decision.
    expect(JSON.stringify(TOOLS).length).toBeLessThan(7000);
  });

  it("names the caller from _meta, else from the client, and reports partial progress on failure", async () => {
    const callers: string[] = [];
    const desktop = {
      look: async (_args: unknown, caller: string) => {
        callers.push(caller);
        return { facts: { windows: [] }, images: [{ data: new Uint8Array([1]), mimeType: "image/png" }] };
      },
      act: async (_args: unknown, caller: string) => {
        callers.push(caller);
        return {
          steps: [{ do: "key", did: "sent Return to foot", disturbed: [] }],
          failed: { index: 1, error: new DesktopError("busy", "Another agent (x) is steering the desktop.") },
        };
      },
      close: async () => {},
    } as unknown as Desktop;
    const client = connect(createServer(desktop, "test"));
    expect((await client.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1" } })).result)
      .toEqual({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ghost-desktop", version: "test" } });
    client.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(((await client.request("tools/list")).result as { tools: unknown }).tools).toEqual(JSON.parse(JSON.stringify(TOOLS)));
    const look = (await client.request("tools/call", { name: LOOK, arguments: {} })).result as { content: unknown };
    expect(look.content).toEqual([{ type: "text", text: '{"windows":[]}' }, { type: "image", data: "AQ==", mimeType: "image/png" }]);
    const act = (await client.request("tools/call", { name: ACT, arguments: { steps: [{ do: "key", keys: "Return" }] }, _meta: { caller: "ghost dous/conv-1" } })).result as {
      isError: boolean; content: unknown; _meta: unknown;
    };
    expect(act.isError).toBe(true);
    expect((act.content as Array<{ text: string }>)[0]!.text).toContain('"failedStep":1');
    expect((act.content as Array<{ text: string }>)[0]!.text).toContain("busy: Another agent");
    expect(act._meta).toMatchObject({ code: "busy" });
    expect(callers[0]).toMatch(/^claude-code [0-9a-f]{8}$/);
    expect(callers[1]).toBe("ghost dous/conv-1");
    await client.end();
  });

  it("answers ping, refuses unknown methods and bad JSON, and ends with its input", async () => {
    const client = connect(createServer({} as Desktop, "test"));
    expect(await client.request("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await client.request("resources/list")).toMatchObject({ error: { code: -32601 } });
    const lines: string[] = [];
    const input = new PassThrough();
    const served = serveTools(createServer({} as Desktop, "test"), input, (line) => lines.push(line));
    input.end("{not json\n");
    await served;
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: null, error: { code: -32700 } });
    await client.end();
  });
});
