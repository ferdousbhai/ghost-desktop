import { describe, expect, it } from "vitest";
import { createHypr, encodeIntent, luaString, resolveWindow, windowShown, type HyprClient, type HyprMonitor } from "../src/hypr.js";
import type { Runner } from "../src/run.js";

const client = (over: Partial<HyprClient>): HyprClient => ({
  address: "0xa", class: "foot", title: "foot", pid: 1, at: [0, 0], size: [100, 100],
  workspace: { id: 1, name: "1" }, monitor: 0, floating: false, fullscreen: 0, hidden: false, mapped: true, focusHistoryID: 0, ...over,
});

describe("dispatch encoding", () => {
  it("escapes every value into a Lua literal, never raw code", () => {
    expect(luaString('a"b\\c\n')).toBe('"a\\034b\\092c\\010"');
    expect(encodeIntent({ kind: "exec", command: 'x"); os.exit(' }, true)).toEqual(['hl.dsp.exec_cmd("x\\034); os.exit(")']);
  });

  it("speaks both grammars for each intent", () => {
    expect(encodeIntent({ kind: "focus", address: "0xa" }, true)).toEqual(['hl.dsp.focus({ window = "address:0xa" })']);
    expect(encodeIntent({ kind: "focus", address: "0xa" }, false)).toEqual(["focuswindow", "address:0xa"]);
    expect(encodeIntent({ kind: "workspace", workspace: "3" }, true)).toEqual(["hl.dsp.focus({ workspace = 3 })"]);
    expect(encodeIntent({ kind: "move", address: "0xa", workspace: "2" }, true)[0]).toContain("follow = false");
    expect(encodeIntent({ kind: "shortcut", mods: "CTRL", key: "s", address: "0xa" }, false)).toEqual(["sendshortcut", "CTRL,s,address:0xa"]);
  });

  it("picks the grammar from the config provider once", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push([...argv]);
      return argv[2] === "status" ? { code: 0, stdout: '{"configProvider":"lua"}', stderr: "" } : { code: 0, stdout: "ok", stderr: "" };
    };
    const hypr = createHypr(run, {});
    await hypr.dispatch({ kind: "workspace", workspace: "2" });
    await hypr.dispatch({ kind: "workspace", workspace: "3" });
    expect(calls.filter((argv) => argv[2] === "status")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["hyprctl", "dispatch", "hl.dsp.focus({ workspace = 3 })"]);
  });

  it("treats a refusal as failure and an unknown lock state as unknown", async () => {
    const run: Runner = async (argv) => ({ code: argv[0] === "loginctl" ? 1 : 0, stdout: argv[1] === "locked" ? "maybe" : "nope", stderr: "" });
    const hypr = createHypr(run, {});
    await expect(hypr.dispatch({ kind: "focus", address: "0xa" })).rejects.toMatchObject({ code: "failed" });
    expect(await hypr.locked()).toBeNull();
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
