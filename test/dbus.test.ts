import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DBusConnection,
  DBusError,
  decodeMessages,
  encodeMessage,
  marshal,
  MessageType,
  socketPathOf,
  splitSignature,
  unmarshal,
  variant,
  type DBusMessage,
  type DBusValue,
} from "../src/dbus.js";
import { DesktopError } from "../src/errors.js";

describe("signatures", () => {
  it("splits into complete types", () => {
    expect(splitSignature("sa{sv}(ii)aa(so)v")).toEqual(["s", "a{sv}", "(ii)", "aa(so)", "v"]);
  });

  it("refuses unbalanced and unknown types", () => {
    expect(() => splitSignature("(ii")).toThrow(/unbalanced|ends early/);
    expect(() => splitSignature("z")).toThrow(/unsupported/);
  });
});

describe("marshalling", () => {
  const roundTrip = (signature: string, values: DBusValue[]) => unmarshal(signature, marshal(signature, values));

  it("round-trips every basic type", () => {
    const values: DBusValue[] = [7, true, -3, 65000, -70000, 4000000000, -5n, 2n ** 63n, 1.5, "héllo", "/a/b", "a(so)"];
    expect(roundTrip("ybnqiuxtdsog", values)).toEqual(values);
  });

  it("aligns after odd-sized fields", () => {
    const bytes = marshal("yt", [1, 9n]);
    expect(bytes.length).toBe(16);
    expect(unmarshal("yt", bytes)).toEqual([1, 9n]);
  });

  it("pads an empty array to its element alignment", () => {
    // u32 length 0 at 4, then padding to 8 for the struct elements.
    const bytes = marshal("ya(ii)y", [1, [], 2]);
    expect(bytes.length).toBe(9);
    expect(unmarshal("ya(ii)y", bytes)).toEqual([1, [], 2]);
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

  it("respects a base offset", () => {
    const bytes = marshal("t", [1n], 4);
    expect(bytes.length).toBe(12);
  });

  it("reads big-endian data", () => {
    const be = new Uint8Array([0, 0, 0, 5, 0, 0, 0, 1, 0x61, 0]);
    expect(unmarshal("us", be, false)).toEqual([5, "a"]);
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

type Handler = (message: DBusMessage) => { signature?: string; body?: DBusValue[] } | { error: string; text: string } | null;

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function fakeBus(handler: Handler): Promise<string> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dbus-"));
  const path = join(dir, "bus");
  let serial = 1000;
  const server = net.createServer((socket) => {
    let authed = false;
    let buffer: Uint8Array = new Uint8Array(0);
    socket.on("data", (chunk: Buffer) => {
      if (!authed) {
        const text = chunk.toString("latin1");
        if (text.includes("AUTH")) socket.write("OK 0123456789abcdef\r\n");
        if (!text.includes("BEGIN")) return;
        authed = true;
        chunk = Buffer.from(text.slice(text.indexOf("BEGIN\r\n") + 7), "latin1");
      }
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      const { messages, rest } = decodeMessages(joined);
      buffer = rest;
      for (const message of messages) {
        const answer = message.member === "Hello" ? { signature: "s", body: [":1.42"] } : handler(message);
        if (answer === null) continue;
        if ("error" in answer) {
          socket.write(encodeMessage({ type: MessageType.Error, serial: ++serial, replySerial: message.serial, errorName: answer.error, signature: "s", body: [answer.text] }));
        } else {
          socket.write(encodeMessage({ type: MessageType.MethodReturn, serial: ++serial, replySerial: message.serial, ...(answer.signature ? { signature: answer.signature, body: answer.body ?? [] } : {}) }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return `unix:path=${path}`;
}

describe("DBusConnection", () => {
  it("authenticates, says Hello, and matches replies to calls", async () => {
    const address = await fakeBus((m) => ({ signature: "s", body: [`${m.member}:${m.body?.[0]}`] }));
    const conn = await DBusConnection.connect(address);
    cleanup.push(() => conn.close());
    expect(conn.uniqueName).toBe(":1.42");
    const results = await Promise.all(["a", "b", "c"].map((x) =>
      conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Echo", signature: "s", body: [x] })));
    expect(results).toEqual([["Echo:a"], ["Echo:b"], ["Echo:c"]]);
  });

  it("turns error replies into DBusError and unwraps properties", async () => {
    const address = await fakeBus((m) => {
      if (m.member === "Get") return { signature: "v", body: [variant("s", `prop ${m.body?.[1]}`)] };
      return { error: "org.freedesktop.DBus.Error.UnknownMethod", text: "no such method" };
    });
    const conn = await DBusConnection.connect(address);
    cleanup.push(() => conn.close());
    expect(await conn.getProperty("d", "/p", "i.I", "Name")).toBe("prop Name");
    await expect(conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Nope" }))
      .rejects.toMatchObject({ name: "DBusError", dbusName: "org.freedesktop.DBus.Error.UnknownMethod", message: "no such method" });
  });

  it("times out a call that gets no reply, and fails pending calls on close", async () => {
    const address = await fakeBus(() => null);
    const conn = await DBusConnection.connect(address);
    await expect(conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Slow", timeoutMs: 50 }))
      .rejects.toThrow(/no reply within 50ms/);
    const pending = conn.call({ destination: "d", path: "/p", interface: "i.I", member: "Slow", timeoutMs: 5000 });
    conn.close();
    await expect(pending).rejects.toBeInstanceOf(DBusError);
  });

  it("reports a dead socket as unavailable", async () => {
    await expect(DBusConnection.connect("unix:path=/nonexistent/bus")).rejects.toMatchObject({ code: "unavailable" });
  });
});
