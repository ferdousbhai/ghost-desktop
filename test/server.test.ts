import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Desktop } from "../src/desktop.js";
import { DesktopError } from "../src/errors.js";
import { ACT, LOOK, TOOLS, createServer } from "../src/server.js";

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
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(desktop, "test").connect(serverSide);
    const client = new Client({ name: "claude-code", version: "1" });
    await client.connect(clientSide);
    const look = await client.callTool({ name: LOOK, arguments: {} });
    expect(look.content).toEqual([{ type: "text", text: '{"windows":[]}' }, { type: "image", data: "AQ==", mimeType: "image/png" }]);
    const act = await client.callTool({ name: ACT, arguments: { steps: [{ do: "key", keys: "Return" }] }, _meta: { caller: "ghost dous/conv-1" } });
    expect(act.isError).toBe(true);
    expect((act.content as Array<{ text: string }>)[0]!.text).toContain('"failedStep":1');
    expect((act.content as Array<{ text: string }>)[0]!.text).toContain("busy: Another agent");
    expect(act._meta).toMatchObject({ code: "busy" });
    expect(callers[0]).toMatch(/^claude-code [0-9a-f]{8}$/);
    expect(callers[1]).toBe("ghost dous/conv-1");
  });
});
