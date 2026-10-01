import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Atspi, AxElement } from "../src/atspi.js";
import type { Capture } from "../src/capture.js";
import { createDesktop } from "../src/desktop.js";
import { DesktopError } from "../src/errors.js";
import type { Hypr, HyprClient, Intent } from "../src/hypr.js";
import { DesktopLease } from "../src/lease.js";
import type { Runner } from "../src/run.js";
import type { VirtualPointer } from "../src/wayland.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const foot: HyprClient = {
  address: "0xa", class: "foot", title: "foot", pid: 7, at: [0, 0], size: [400, 300], workspace: { id: 1, name: "1" },
  monitor: 0, floating: false, fullscreen: 0, hidden: false, mapped: true, focusHistoryID: 0, stable_id: "s1",
};
const files: HyprClient = { ...foot, address: "0xb", class: "org.gnome.Nautilus", title: "data", pid: 8, at: [0, 300], focusHistoryID: 1 };

function element(ref: string, name: string, over: Partial<AxElement> = {}): AxElement {
  return { ref, role: "button", name, states: ["sensitive", "showing"], actions: ["click"], x: 10, y: 310, width: 20, height: 20, ...over };
}

function harness(options: { locked?: boolean | null; elements?: AxElement[]; shortcutFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ghost-desktop-"));
  dirs.push(dir);
  const dispatched: Intent[] = [];
  const commands: string[][] = [];
  const pointerCalls: string[] = [];
  const performed: string[] = [];
  let active = "0xa";
  const hypr: Hypr = {
    clients: async () => [foot, files],
    monitors: async () => [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1200, height: 800, scale: 1, focused: true, activeWorkspace: { id: 1, name: "1" } }],
    activeAddress: async () => active,
    layers: async () => [],
    cursor: async () => [0, 0],
    locked: async () => (options.locked === undefined ? false : options.locked),
    dispatch: async (intent) => {
      if (intent.kind === "shortcut" && options.shortcutFails) throw new DesktopError("failed", "no keysym");
      dispatched.push(intent);
      if (intent.kind === "focus") active = intent.address;
    },
  };
  const elements = options.elements ?? [element("e1", "Search"), element("e2", "Close")];
  const atspi: Atspi = {
    query: async (_window, query) => {
      const found = elements.filter((item) => !query.text || item.name.toLowerCase().includes(query.text.toLowerCase()));
      return { elements: found.slice(0, query.limit), total: found.length, roles: { button: found.length } };
    },
    perform: async (ref, action) => void performed.push(`${ref}:${action ?? ""}`),
    setText: async (ref, text) => void performed.push(`${ref}=${text}`),
    setValue: async (ref, value) => void performed.push(`${ref}=${value}`),
    focus: async (ref) => void performed.push(`${ref}:focus`),
    element: async (ref) => {
      const found = elements.find((item) => item.ref === ref);
      if (!found) throw new DesktopError("not_found", `Unknown ref ${ref}`);
      return found;
    },
    at: async () => null,
    focusedEditable: async () => null,
    close: async () => {},
  };
  const pointer: VirtualPointer = {
    button: async (button, pressed) => void pointerCalls.push(`${button}:${pressed ? "down" : "up"}`),
    click: async (button, clicks) => void pointerCalls.push(`click ${button} x${clicks}`),
    scroll: async (dy, dx) => void pointerCalls.push(`scroll ${dy},${dx}`),
    motion: async () => {},
    close: async () => {},
  };
  const run: Runner = async (argv) => {
    commands.push([...argv]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const capture = {} as Capture;
  const desktop = createDesktop({
    hypr, capture, atspi: () => atspi, pointer: async () => pointer, lease: new DesktopLease(dir), run, env: {}, sleep: async () => {},
  });
  return { desktop, dispatched, commands, pointerCalls, performed, dir };
}

describe("desktop_act", () => {
  it("does nothing on a locked or unknown session", async () => {
    await expect(harness({ locked: true }).desktop.act({ steps: [{ do: "key", keys: "Return" }] }, "a")).rejects.toMatchObject({ code: "locked" });
    const unknown = harness({ locked: null });
    await expect(unknown.desktop.act({ steps: [{ do: "key", keys: "Return" }] }, "a")).rejects.toMatchObject({ code: "locked" });
    expect(unknown.dispatched).toEqual([]);
  });

  it("refuses a second caller while the first holds the desktop", async () => {
    const { desktop, dir } = harness();
    await desktop.act({ steps: [{ do: "key", keys: "Return" }] }, "ghost");
    const other = createDesktop({ hypr: { locked: async () => false } as Hypr, lease: new DesktopLease(dir) } as never);
    await expect(other.act({ steps: [{ do: "key", keys: "Return" }] }, "claude")).rejects.toMatchObject({ code: "busy" });
  });

  it("sends a chord to the window without moving focus, and falls back to the focused one", async () => {
    const quiet = harness();
    const done = await quiet.desktop.act({ steps: [{ do: "key", keys: "ctrl+s", window: "org.gnome.Nautilus" }] }, "a");
    expect(quiet.dispatched).toEqual([{ kind: "shortcut", mods: "CTRL", key: "s", address: "0xb" }]);
    expect(done.steps[0]!.disturbed).toEqual([]);
    const loud = harness({ shortcutFails: true });
    const fallback = await loud.desktop.act({ steps: [{ do: "key", keys: "ctrl+s", window: "org.gnome.Nautilus" }] }, "a");
    expect(loud.commands.at(-1)).toEqual(["wtype", "-M", "ctrl", "-k", "s", "-m", "ctrl"]);
    expect(fallback.steps[0]!.disturbed).toEqual(["focus"]);
  });

  it("clicks a named control at its center with the real pointer, focusing its window first", async () => {
    const { desktop, dispatched, pointerCalls } = harness();
    const result = await desktop.act({ steps: [{ do: "click", name: "search", window: "org.gnome.Nautilus" }] }, "a");
    expect(dispatched).toEqual([{ kind: "focus", address: "0xb" }, { kind: "cursor", x: 20, y: 320 }]);
    expect(pointerCalls).toEqual(["click left x1"]);
    expect(result.steps[0]!.disturbed).toEqual(["focus", "pointer"]);
  });

  it("refuses an ambiguous name and lists refs", async () => {
    const { desktop } = harness({ elements: [element("e1", "View Options"), element("e2", "View Options")] });
    const result = await desktop.act({ steps: [{ do: "perform", name: "View Options" }] }, "a");
    expect(result.failed?.error.message).toMatch(/2 controls match.*e1.*e2/);
  });

  it("stops at the first failing step and keeps what was done", async () => {
    const { desktop, performed } = harness();
    const result = await desktop.act({
      steps: [{ do: "perform", ref: "e1" }, { do: "set", ref: "e9", value: "x" }, { do: "perform", ref: "e2" }],
    }, "a");
    expect(performed).toEqual(["e1:"]);
    expect(result.steps).toHaveLength(1);
    expect(result.failed).toMatchObject({ index: 1, error: { code: "not_found" } });
  });

  it("types long text as wtype's argument, never through stdin", async () => {
    const { desktop, commands } = harness();
    const text = `${"ab".repeat(60)}XYZ`;
    await desktop.act({ steps: [{ do: "type", text }] }, "a");
    expect(commands.at(-1)).toEqual(["wtype", "--", text]);
  });

  it("drags with intermediate motion and always releases", async () => {
    const { desktop, dispatched, pointerCalls } = harness();
    await desktop.act({ steps: [{ do: "drag", x: 0, y: 0, to_x: 120, to_y: 0 }] }, "a");
    expect(pointerCalls).toEqual(["left:down", "left:up"]);
    expect(dispatched.filter((intent) => intent.kind === "cursor")).toHaveLength(13);
  });
});
