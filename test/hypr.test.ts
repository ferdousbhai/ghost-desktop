import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHypr, encodeIntent, luaString, resolveWindow, socketRequest, windowShown, type HyprClient, type HyprMonitor } from "../src/hypr.js";
import type { Runner } from "../src/run.js";

const client = (over: Partial<HyprClient>): HyprClient => ({
  address: "0xa", class: "foot", title: "foot", pid: 1, at: [0, 0], size: [100, 100],
  workspace: { id: 1, name: "1" }, floating: false, fullscreen: 0, hidden: false, mapped: true, focusHistoryID: 0, ...over,
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

/** A stand-in Hyprland: its request and event sockets in a temp runtime dir. */
function fakeHyprland(answer: (command: string) => string) {
  const runtime = mkdtempSync(join(tmpdir(), "ghost-desktop-hypr-"));
  const dir = join(runtime, "hypr", "sig");
  mkdirSync(dir, { recursive: true });
  const requests: string[] = [];
  const listeners: Array<(line: string) => void> = [];
  const servers: Server[] = [
    createServer((socket) => socket.on("data", (data) => {
      requests.push(data.toString());
      socket.end(answer(data.toString()));
    })).listen(join(dir, ".socket.sock")),
    createServer((socket) => {
      listeners.push((line) => socket.write(`${line}\n`));
    }).listen(join(dir, ".socket2.sock")),
  ];
  cleanup.push(() => {
    for (const server of servers) server.close();
    rmSync(runtime, { recursive: true, force: true });
  });
  const emit = (line: string) => {
    for (const send of listeners) send(line);
  };
  return { env: { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: "sig" }, requests, emit };
}

describe("dispatch encoding", () => {
  it("escapes every value into a Lua literal, never raw code", () => {
    expect(luaString('a"b\\c\n')).toBe('"a\\034b\\092c\\010"');
    expect(encodeIntent({ kind: "exec", command: 'x"); os.exit(' }, true)).toBe('hl.dsp.exec_cmd("x\\034); os.exit(")');
  });

  it("speaks both grammars for each intent", () => {
    expect(encodeIntent({ kind: "focus", address: "0xa" }, true)).toBe('hl.dsp.focus({ window = "address:0xa" })');
    expect(encodeIntent({ kind: "focus", address: "0xa" }, false)).toBe("focuswindow address:0xa");
    expect(encodeIntent({ kind: "workspace", workspace: "3" }, true)).toBe("hl.dsp.focus({ workspace = 3 })");
    expect(encodeIntent({ kind: "move", address: "0xa", workspace: "2" }, true)).toContain("follow = false");
    expect(encodeIntent({ kind: "shortcut", mods: "CTRL", key: "s", address: "0xa" }, false)).toBe("sendshortcut CTRL,s,address:0xa");
  });
});

describe("createHypr", () => {
  it("talks to Hyprland's own socket, and picks the grammar from the config provider once", async () => {
    const hyprland = fakeHyprland((command) => (command === "j/status" ? '{"configProvider":"lua"}' : command === "j/clients" ? "[]" : "ok"));
    const hypr = createHypr({ env: hyprland.env });
    expect(await hypr.clients()).toEqual([]);
    await hypr.dispatch({ kind: "workspace", workspace: "2" });
    await hypr.dispatch({ kind: "workspace", workspace: "3" });
    expect(hyprland.requests).toEqual(["j/clients", "j/status", "dispatch hl.dsp.focus({ workspace = 2 })", "dispatch hl.dsp.focus({ workspace = 3 })"]);
  });

  it("treats a refusal as failure and an unknown lock state as unknown", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
    const hypr = createHypr({ env: {}, run, request: async (command) => (command === "locked" ? "maybe" : "nope") });
    await expect(hypr.dispatch({ kind: "focus", address: "0xa" })).rejects.toMatchObject({ code: "failed" });
    expect(await hypr.locked()).toBeNull();
  });

  it("waits for a matching event that its own action causes", async () => {
    const hyprland = fakeHyprland(() => "ok");
    const hypr = createHypr({ env: hyprland.env, request: async () => "ok" });
    const seen = await hypr.waitEvent(["openwindow"], {
      timeoutMs: 2000,
      match: "foot",
      after: async () => {
        await Bun.sleep(20);
        hyprland.emit("openwindow>>dead,1,firefox,Docs");
        hyprland.emit("openwindow>>beef,2,foot,foot");
      },
    });
    expect(seen).toEqual({ name: "openwindow", data: "beef,2,foot,foot" });
    expect(await hypr.waitEvent(["closewindow"], { timeoutMs: 50 })).toBeNull();
  });

  it("says the session is not Hyprland when its socket is missing", async () => {
    await expect(socketRequest({ XDG_RUNTIME_DIR: tmpdir(), HYPRLAND_INSTANCE_SIGNATURE: "none" })("j/clients")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("resolveWindow", () => {
  const clients = [client({ address: "0xa", class: "foot", focusHistoryID: 1 }), client({ address: "0xb", class: "foot", title: "logs", focusHistoryID: 0 }), client({ address: "0xc", class: "firefox", title: "Docs" })];

  it("prefers address, then class (most recently focused), then title", () => {
    expect(resolveWindow(clients, "0xc", "0xA").address).toBe("0xa");
    expect(resolveWindow(clients, "0xc", "foot").address).toBe("0xb");
    expect(resolveWindow(clients, "0xc", "docs").address).toBe("0xc");
    expect(resolveWindow(clients, "0xc").address).toBe("0xc");
  });

  it("says when nothing matches", () => {
    expect(() => resolveWindow(clients, null, "slack")).toThrow(/No open window/);
    expect(() => resolveWindow(clients, null, "0xdead")).toThrow(/may have closed/);
  });

  it("knows whether a monitor shows the window", () => {
    const monitor = { activeWorkspace: { id: 1, name: "1" } } as HyprMonitor;
    expect(windowShown(client({}), [monitor])).toBe(true);
    expect(windowShown(client({ workspace: { id: 2, name: "2" } }), [monitor])).toBe(false);
  });
});
