import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { centerOf, createAtspi, STATE_NAMES, type Atspi, type AxWindow } from "../src/atspi.js";
import { variant, type DBusMessage, type DBusValue } from "../src/dbus.js";
import { fakeBus, type FakeBus, type FakeReply } from "./helpers/fake-bus.js";

function stateWords(names: string[]): number[] {
  const words = [0, 0];
  for (const name of names) {
    const bit = (STATE_NAMES as readonly string[]).indexOf(name);
    words[bit >> 5]! += 2 ** (bit & 31);
  }
  return words;
}

interface FakeNode {
  role: string;
  name: string;
  states: string[];
  children: string[];
  extents?: [number, number, number, number];
  actions?: string[];
  text?: string;
  value?: number;
  editable?: boolean;
}

const APP = ":1.5";
const ROOT = "/org/a11y/atspi/accessible/root";
const SHOWN = ["showing", "visible", "sensitive", "enabled"];

function tree(): Record<string, FakeNode> {
  return {
    [ROOT]: { role: "application", name: "files", states: [], children: ["/f1", "/f2"] },
    "/f1": { role: "frame", name: "Files", states: [...SHOWN, "active"], children: ["/b1", "/t1", "/h1", "/s1", "/c1"], extents: [0, 0, 600, 400] },
    "/b1": { role: "push button", name: "Search", states: [...SHOWN, "focusable"], children: [], extents: [10, 20, 30, 40], actions: ["click"] },
    "/t1": { role: "text", name: "Query", states: [...SHOWN, "editable", "focused"], children: [], extents: [50, 20, 200, 30], text: "hello", editable: true },
    "/h1": { role: "panel", name: "", states: ["visible"], children: ["/h2"], extents: [0, 0, 10, 10] },
    "/h2": { role: "push button", name: "Hidden", states: SHOWN, children: [], actions: ["click"] },
    "/s1": { role: "slider", name: "Volume", states: SHOWN, children: [], extents: [10, 100, 100, 20], value: 0.5 },
    "/c1": { role: "check box", name: "Bold", states: [...SHOWN, "checked"], children: [], extents: [10, 150, 20, 20], actions: ["toggle", "press"] },
    "/f2": { role: "frame", name: "Other", states: SHOWN, children: ["/b2"], extents: [0, 0, 300, 300] },
    "/b2": { role: "push button", name: "Other button", states: SHOWN, children: [], extents: [5, 5, 20, 20], actions: ["click"] },
  };
}

let bus: FakeBus;
let nodes: Record<string, FakeNode>;
let calls: string[];
let atspi: Atspi;

function answer(m: DBusMessage, self: string): FakeReply {
  const body = m.body ?? [];
  if (m.interface === "org.a11y.Bus") return { signature: "s", body: [self] };
  if (m.member === "GetConnectionUnixProcessID") return { signature: "u", body: [body[0] === APP ? 4242 : 1] };
  if (m.destination === "org.a11y.atspi.Registry") return { signature: "a(so)", body: [[[":1.9", ROOT], [APP, ROOT]]] };
  const node = m.destination === APP ? nodes[m.path ?? ""] : undefined;
  if (!node) return { error: "org.freedesktop.DBus.Error.UnknownObject", text: `no object ${m.path}` };
  const id = `${m.member} ${m.path}`;
  switch (m.member) {
    case "GetRoleName": return { signature: "s", body: [node.role] };
    case "GetState": return { signature: "au", body: [stateWords(node.states)] };
    case "GetChildren": return { signature: "a(so)", body: [node.children.map((c) => [APP, c])] };
    case "GetInterfaces": {
      const ifaces = ["org.a11y.atspi.Accessible"];
      if (node.extents) ifaces.push("org.a11y.atspi.Component");
      if (node.actions) ifaces.push("org.a11y.atspi.Action");
      if (node.text !== undefined) ifaces.push("org.a11y.atspi.Text");
      if (node.editable) ifaces.push("org.a11y.atspi.EditableText");
      if (node.value !== undefined) ifaces.push("org.a11y.atspi.Value");
      return { signature: "as", body: [ifaces] };
    }
    case "Get": {
      if (body[1] === "Name") return { signature: "v", body: [variant("s", node.name)] };
      if (body[1] === "CurrentValue") return { signature: "v", body: [variant("d", node.value ?? 0)] };
      return { error: "org.freedesktop.DBus.Error.InvalidArgs", text: "no property" };
    }
    case "Set": calls.push(`${id} ${String(body[1])}=${String((body[2] as { value: DBusValue }).value)}`); return {};
    case "GetExtents": return { signature: "(iiii)", body: [node.extents ?? [0, 0, 0, 0]] };
    case "GetActions": return { signature: "a(sss)", body: [(node.actions ?? []).map((a) => [a, "", ""])] };
    case "DoAction": calls.push(`${id} ${String(body[0])}`); return { signature: "b", body: [true] };
    case "GetText": return { signature: "s", body: [node.text ?? ""] };
    case "SetTextContents":
      if (!node.editable) return { error: "org.freedesktop.DBus.Error.UnknownMethod", text: "No such interface “org.a11y.atspi.EditableText”" };
      calls.push(`${id} ${String(body[0])}`); return { signature: "b", body: [true] };
    case "GrabFocus": calls.push(id); return { signature: "b", body: [true] };
    default: return { error: "org.freedesktop.DBus.Error.UnknownMethod", text: `no method ${m.member}` };
  }
}

beforeEach(async () => {
  nodes = tree();
  calls = [];
  bus = await fakeBus((m) => answer(m, bus.address));
  atspi = createAtspi({ DBUS_SESSION_BUS_ADDRESS: bus.address });
});

afterEach(async () => {
  await atspi.close();
  bus.close();
});

const WINDOW: AxWindow = { pid: 4242, at: [100, 200], title: "Files" };

describe("query", () => {
  it("returns the window's actionable elements in screen coordinates, skipping hidden subtrees", async () => {
    const result = await atspi.query(WINDOW, { actionable: true, limit: 50 });
    const names = result.elements.map((e) => e.name);
    expect(names).toEqual(["Search", "Query", "Volume", "Bold"]);
    expect(result.elements[0]).toMatchObject({ role: "push button", box: [110, 220, 30, 40], actions: ["click"] });
    expect(centerOf(result.elements[0]!)).toEqual([125, 240]);
    expect(result.elements[0]!.ref).toMatch(/^e\d+$/);
    expect(result.elements[1]).toMatchObject({ text: "hello", states: expect.arrayContaining(["editable", "focused"]) });
    expect(result.elements[2]).toMatchObject({ value: 0.5 });
    expect(result.elements[3]).toMatchObject({ checked: true });
    expect(names).not.toContain("Hidden");
    expect(names).not.toContain("Other button");
    expect(result.roles).toMatchObject({ frame: 1, "push button": 1, panel: 1 });
  });

  it("filters by text and role, and caps by limit while counting the total", async () => {
    expect((await atspi.query(WINDOW, { text: "HELLO", limit: 5 })).elements.map((e) => e.name)).toEqual(["Query"]);
    expect((await atspi.query(WINDOW, { role: "button", limit: 5 })).elements.map((e) => e.name)).toEqual(["Search"]);
    const capped = await atspi.query(WINDOW, { actionable: true, limit: 2 });
    expect(capped.elements).toHaveLength(2);
    expect(capped.total).toBe(4);
  });

  it("walks every frame when the title matches none", async () => {
    const result = await atspi.query({ ...WINDOW, title: "nothing like it" }, { role: "push button", limit: 10 });
    expect(result.elements.map((e) => e.name)).toEqual(["Search", "Other button"]);
  });

  it("keeps refs stable across queries", async () => {
    const first = await atspi.query(WINDOW, { text: "Search", limit: 1 });
    const second = await atspi.query(WINDOW, { actionable: true, limit: 10 });
    expect(second.elements[0]!.ref).toBe(first.elements[0]!.ref);
  });

  it("says when the window's process has no tree", async () => {
    await expect(atspi.query({ ...WINDOW, pid: 99 }, { limit: 5 }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("force-renderer-accessibility") });
  });

  it("says how to start an unreachable bus", async () => {
    const dead = createAtspi({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus" });
    await expect(dead.query(WINDOW, { limit: 5 }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("at-spi-bus-launcher") });
  });
});

describe("acting by ref", () => {
  async function ref(name: string): Promise<string> {
    const { elements } = await atspi.query(WINDOW, { text: name, limit: 1 });
    return elements[0]!.ref;
  }

  it("performs the default action, or a named one, and lists actions on a miss", async () => {
    await atspi.perform(await ref("Search"));
    await atspi.perform(await ref("Bold"), "press");
    expect(calls).toEqual(["DoAction /b1 0", "DoAction /c1 1"]);
    await expect(atspi.perform(await ref("Bold"), "explode"))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("toggle, press") });
    await expect(atspi.perform(await ref("Volume"))).rejects.toMatchObject({ code: "invalid" });
  });

  it("sets text, value, and focus", async () => {
    await atspi.setText(await ref("Query"), "new text");
    await atspi.setValue(await ref("Volume"), 0.9);
    await atspi.focus(await ref("Search"));
    expect(calls).toEqual(["SetTextContents /t1 new text", "Set /s1 CurrentValue=0.9", "GrabFocus /b1"]);
  });

  it("says what to do instead when an element lacks the interface", async () => {
    await expect(atspi.setText(await ref("Search"), "x"))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("focus it and type instead") });
  });

  it("reads a ref's current window-relative extents and its owner", async () => {
    expect(await atspi.extents(await ref("Search"))).toEqual({ box: [10, 20, 30, 40], pid: 4242 });
  });

  it("refuses unknown refs and reports vanished elements", async () => {
    await expect(atspi.perform("e999999")).rejects.toMatchObject({ code: "not_found" });
    const r = await ref("Search");
    delete nodes["/b1"];
    await expect(atspi.extents(r)).rejects.toMatchObject({ code: "not_found" });
  });
});
