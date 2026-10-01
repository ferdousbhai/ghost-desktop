import { afterEach, describe, expect, it } from "vitest";
import {
  DBusConnection,
  DBusError,
  decodeMessages,
  encodeMessage,
  marshal,
  MessageType,
  socketPathOf,
  variant,
  type DBusValue,
} from "../src/dbus.js";
import { DesktopError } from "../src/errors.js";
import { fakeBus, type FakeBus } from "./helpers/fake-bus.js";

/** Marshal as a message body and decode it back, the only path production reads by. */
function roundTrip(signature: string, values: DBusValue[]): readonly DBusValue[] | undefined {
  const frame = encodeMessage({ type: MessageType.MethodReturn, serial: 1, replySerial: 1, signature, body: values });
  return decodeMessages(frame).messages[0]?.body;
}

describe("signatures", () => {
  it("refuses unbalanced and unknown types", () => {
    expect(() => marshal("(ii", [[1, 2]])).toThrow(/unbalanced|ends early/);
    expect(() => marshal("z", [1])).toThrow(/unsupported/);
  });
});

describe("marshalling", () => {
  it("round-trips every basic type", () => {
    const values: DBusValue[] = [7, true, -3, 65000, -70000, 4000000000, -5n, 2n ** 63n, 1.5, "héllo", "/a/b", "a(so)"];
    expect(roundTrip("ybnqiuxtdsog", values)).toEqual(values);
  });

  it("aligns after odd-sized fields", () => {
    expect(marshal("yt", [1, 9n]).length).toBe(16);
    expect(roundTrip("yt", [1, 9n])).toEqual([1, 9n]);
  });

  it("pads an empty array to its element alignment", () => {
    // u32 length 0 at 4, then padding to 8 for the struct elements.
    expect(marshal("ya(ii)y", [1, [], 2]).length).toBe(9);
    expect(roundTrip("ya(ii)y", [1, [], 2])).toEqual([1, [], 2]);
  });

  it("round-trips structs, dicts, nested arrays, and variants", () => {
    const values: DBusValue[] = [
      [["s", 1], ["t", 2]],
      [[":1.5", "/org/a"], [":1.6", "/org/b"]],
      [[1, 2], [], [3]],
      variant("a{sv}", [["k", variant("d", 0.25)]]),
      [10, 20, 30, 40],
    ];
    expect(roundTrip("a{si}a(so)aaiv(iiii)", values)).toEqual(values);
  });
});

describe("messages", () => {
  it("encodes and decodes a method call, keeping a split tail", () => {
    const frame = encodeMessage({
      type: MessageType.MethodCall, serial: 9, destination: "org.x", path: "/o", interface: "org.x.I",
      member: "M", signature: "su", body: ["hi", 3],
    });
    const joined = new Uint8Array(frame.length * 2 - 5);
    joined.set(frame);
    joined.set(frame.subarray(0, frame.length - 5), frame.length);
    const { messages, rest } = decodeMessages(joined);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 1, serial: 9, destination: "org.x", path: "/o", member: "M", body: ["hi", 3] });
    expect(rest.length).toBe(frame.length - 5);
  });
});

describe("addresses", () => {
  it("picks the first unix socket and decodes escapes", () => {
    expect(socketPathOf("tcp:host=x;unix:path=/run/a%20b,guid=1")).toBe("/run/a b");
    expect(socketPathOf("unix:abstract=foo")).toBe("\0foo");
    expect(() => socketPathOf("tcp:host=x")).toThrow(DesktopError);
  });
});

let buses: FakeBus[] = [];
let conns: DBusConnection[] = [];
afterEach(() => {
  for (const conn of conns) conn.close();
  for (const bus of buses) bus.close();
  buses = [];
  conns = [];
});

async function connect(handler: Parameters<typeof fakeBus>[0], timeoutMs?: number): Promise<DBusConnection> {
  const bus = await fakeBus(handler);
  buses.push(bus);
  const conn = await DBusConnection.connect(bus.address, timeoutMs === undefined ? {} : { timeoutMs });
  conns.push(conn);
  return conn;
}

describe("DBusConnection", () => {
  it("authenticates, says Hello, and matches replies to calls", async () => {
    const conn = await connect((m) => ({ signature: "s", body: [`${m.member}:${m.body?.[0]}`] }));
    const results = await Promise.all(["a", "b", "c"].map((x) =>
      conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Echo", signature: "s", body: [x] })));
    expect(results).toEqual([["Echo:a"], ["Echo:b"], ["Echo:c"]]);
  });

  it("reassembles a reply that arrives in many chunks", async () => {
    const big = "x".repeat(200_000);
    const conn = await connect(() => ({ signature: "s", body: [big] }));
    expect(await conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Big" })).toEqual([big]);
  });

  it("turns error replies into DBusError", async () => {
    const conn = await connect(() => ({ error: "org.freedesktop.DBus.Error.UnknownMethod", text: "no such method" }));
    await expect(conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Nope" }))
      .rejects.toMatchObject({ name: "DBusError", dbusName: "org.freedesktop.DBus.Error.UnknownMethod", message: "no such method" });
  });

  it("times out a call that gets no reply, and fails pending calls on close", async () => {
    const quick = await connect(() => null, 50);
    await expect(quick.call({ destination: "d", path: "/p", interface: "i.I", member: "Slow" }))
      .rejects.toThrow(/no reply within 50ms/);
    const conn = await connect(() => null);
    const pending = conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Slow" });
    conn.close();
    await expect(pending).rejects.toBeInstanceOf(DBusError);
  });

  it("reports a dead socket as unavailable", async () => {
    await expect(DBusConnection.connect("unix:path=/nonexistent/bus")).rejects.toMatchObject({ code: "unavailable" });
  });
});
